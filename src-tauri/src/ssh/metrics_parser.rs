// ssh/metrics_parser.rs — Pure parsers for remote system metrics
//
// All structs and functions here are dependency-free (no russh, no Tauri).
// They can be fully unit-tested without any SSH connection.
//
// Input format: combined command output split by ===SECTION=== markers:
//   ===STAT===
//   <cat /proc/stat output>
//   ===MEM===
//   <cat /proc/meminfo output>
//   ===NET===
//   <cat /proc/net/dev output>
//   ===DISK===
//   <df -kP output>
//   ===PS===
//   <ps -eo pid,user,pcpu,pmem,comm output>
//
// Parsing policy: DEGRADE GRACEFULLY — a missing or malformed section always
// returns zeroes/empty, never an error that would stop the sampler.

// ─── Raw CPU sample ─────────────────────────────────────────────────────────

/// Raw values from /proc/stat's first "cpu" line.
///
/// `total` = sum of all jiffies; `idle` = idle + iowait jiffies.
/// On the first tick these are stored as the `prev` state.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CpuRaw {
    pub total: u64,
    pub idle: u64,
}

// ─── Memory sample ──────────────────────────────────────────────────────────

/// /proc/meminfo MemTotal and MemAvailable (in kB).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MemSample {
    pub total_kb: u64,
    pub available_kb: u64,
}

impl MemSample {
    /// Usage percentage: (total - available) / total * 100.
    /// Returns 0.0 if total == 0 (guard against divide-by-zero).
    pub fn usage_pct(&self) -> f32 {
        if self.total_kb == 0 {
            return 0.0;
        }
        let used = self.total_kb.saturating_sub(self.available_kb);
        (used as f32 / self.total_kb as f32) * 100.0
    }
}

// ─── Network sample ─────────────────────────────────────────────────────────

/// Raw per-interface byte counters from /proc/net/dev.
#[derive(Debug, Clone, PartialEq)]
pub struct NetIfaceRaw {
    pub iface: String,
    pub rx_bytes: u64,
    pub tx_bytes: u64,
}

// ─── Disk sample ────────────────────────────────────────────────────────────

/// One filesystem row from `df -kP`.
#[derive(Debug, Clone, PartialEq)]
pub struct DiskSample {
    pub filesystem: String,
    /// Used percentage (0–100).
    pub used_pct: u8,
    pub available_kb: u64,
}

// ─── Process row ────────────────────────────────────────────────────────────

/// One process row from `ps -eo pid,user,pcpu,pmem,comm`.
#[derive(Debug, Clone, PartialEq)]
pub struct ProcessRow {
    pub pid: u32,
    pub user: String,
    pub cpu_pct: f32,
    pub mem_pct: f32,
    pub name: String,
}

// ─── Parsed raw (output of parse_combined) ──────────────────────────────────

/// All parsed sections in one bundle — missing sections are zeroed/empty.
#[derive(Debug, Clone)]
pub struct ParsedRaw {
    /// None if /proc/stat was absent or unparseable.
    pub cpu: Option<CpuRaw>,
    pub mem: MemSample,
    pub net: Vec<NetIfaceRaw>,
    pub disk: Vec<DiskSample>,
    pub processes: Vec<ProcessRow>,
}

// ─── parse_proc_stat ────────────────────────────────────────────────────────

/// Parse the first "cpu" line of /proc/stat.
///
/// Format: `cpu  user nice system idle iowait irq softirq ...` (8+ fields after "cpu").
/// Returns `None` if the line is absent or malformed.
///
/// `idle` here includes iowait (field index 4 + 5) because iowait time is time
/// the CPU is idle waiting for I/O — matching what tools like `top` do.
pub fn parse_proc_stat(output: &str) -> Option<CpuRaw> {
    for line in output.lines() {
        let line = line.trim();
        // The aggregate CPU line starts with "cpu " (followed by spaces, not "cpu0" etc.)
        if !line.starts_with("cpu ") {
            continue;
        }
        let parts: Vec<&str> = line.split_whitespace().collect();
        // "cpu" + at least user, nice, system, idle (4 fields minimum = index 0..4)
        if parts.len() < 5 {
            return None;
        }
        let parse = |s: &str| s.parse::<u64>().ok();
        let user = parse(parts[1])?;
        let nice = parse(parts[2])?;
        let system = parse(parts[3])?;
        let idle = parse(parts[4])?;
        // iowait is optional (field 5) — treat as 0 if missing
        let iowait = parts.get(5).and_then(|s| parse(s)).unwrap_or(0);
        let irq = parts.get(6).and_then(|s| parse(s)).unwrap_or(0);
        let softirq = parts.get(7).and_then(|s| parse(s)).unwrap_or(0);
        let steal = parts.get(8).and_then(|s| parse(s)).unwrap_or(0);

        let total = user + nice + system + idle + iowait + irq + softirq + steal;
        // idle for delta purposes = idle + iowait
        let idle_plus_iowait = idle + iowait;
        return Some(CpuRaw {
            total,
            idle: idle_plus_iowait,
        });
    }
    None
}

// ─── cpu_delta ──────────────────────────────────────────────────────────────

/// Compute CPU usage percentage between two consecutive /proc/stat samples.
///
/// Returns 0.0 when:
/// - total delta is zero (no jiffies elapsed — clock stall or first tick)
/// - result would be negative (time went backward — clock wrap / kernel quirk)
pub fn cpu_delta(prev: &CpuRaw, curr: &CpuRaw) -> f32 {
    let delta_total = curr.total.saturating_sub(prev.total);
    let delta_idle = curr.idle.saturating_sub(prev.idle);
    if delta_total == 0 {
        return 0.0;
    }
    let used = delta_total.saturating_sub(delta_idle);
    ((used as f32 / delta_total as f32) * 100.0).clamp(0.0, 100.0)
}

// ─── parse_meminfo ──────────────────────────────────────────────────────────

/// Parse /proc/meminfo for MemTotal and MemAvailable.
///
/// Returns zero-valued MemSample if either key is missing.
pub fn parse_meminfo(output: &str) -> MemSample {
    let mut total_kb: Option<u64> = None;
    let mut available_kb: Option<u64> = None;

    for line in output.lines() {
        let line = line.trim();
        if line.starts_with("MemTotal:") {
            total_kb = parse_meminfo_kb(line);
        } else if line.starts_with("MemAvailable:") {
            available_kb = parse_meminfo_kb(line);
        }
        if total_kb.is_some() && available_kb.is_some() {
            break;
        }
    }

    MemSample {
        total_kb: total_kb.unwrap_or(0),
        available_kb: available_kb.unwrap_or(0),
    }
}

fn parse_meminfo_kb(line: &str) -> Option<u64> {
    // Format: "MemTotal:       16384 kB"
    let after_colon = line.split_once(':')?.1.trim();
    let value_str = after_colon.split_whitespace().next()?;
    value_str.parse().ok()
}

// ─── parse_net_dev ───────────────────────────────────────────────────────────

/// Parse /proc/net/dev for per-interface rx_bytes and tx_bytes.
///
/// Lines to parse look like:
///   `  eth0:  12345  ...  67890  ...` (16 space-separated fields after the colon).
/// The header lines (containing "|") are skipped. "lo" (loopback) is excluded.
pub fn parse_net_dev(output: &str) -> Vec<NetIfaceRaw> {
    let mut result = Vec::new();
    for line in output.lines() {
        let line = line.trim();
        // Skip header lines
        if line.contains('|') || line.is_empty() {
            continue;
        }
        let Some(colon_pos) = line.find(':') else {
            continue;
        };
        let iface = line[..colon_pos].trim().to_string();
        // Skip loopback
        if iface == "lo" {
            continue;
        }
        let after = &line[colon_pos + 1..];
        let fields: Vec<&str> = after.split_whitespace().collect();
        // /proc/net/dev: rx_bytes is field [0], tx_bytes is field [8]
        if fields.len() < 9 {
            continue;
        }
        let rx_bytes = fields[0].parse::<u64>().unwrap_or(0);
        let tx_bytes = fields[8].parse::<u64>().unwrap_or(0);
        result.push(NetIfaceRaw {
            iface,
            rx_bytes,
            tx_bytes,
        });
    }
    result
}

/// Compute aggregate (rx_bps, tx_bps) across all matching interfaces between
/// two samples, given the elapsed time in seconds.
///
/// Returns (0, 0) if `elapsed_secs` is zero or negative.
pub fn net_delta(prev: &[NetIfaceRaw], curr: &[NetIfaceRaw], elapsed_secs: f64) -> (u64, u64) {
    if elapsed_secs <= 0.0 {
        return (0, 0);
    }
    let mut rx_total: u64 = 0;
    let mut tx_total: u64 = 0;
    for c in curr {
        if let Some(p) = prev.iter().find(|p| p.iface == c.iface) {
            rx_total += c.rx_bytes.saturating_sub(p.rx_bytes);
            tx_total += c.tx_bytes.saturating_sub(p.tx_bytes);
        }
    }
    let rx_bps = (rx_total as f64 / elapsed_secs) as u64;
    let tx_bps = (tx_total as f64 / elapsed_secs) as u64;
    (rx_bps, tx_bps)
}

// ─── parse_df ────────────────────────────────────────────────────────────────

/// Parse `df -kP` output into DiskSample entries.
///
/// POSIX -P format:
///   `Filesystem     1024-blocks      Used Available Capacity Mounted on`
///   `/dev/sda1         10485760   5242880   5242880      50% /`
///
/// Filters out tmpfs, devtmpfs, overlay, squashfs, udev, and rootfs entries
/// to reduce noise. Handles busybox df that may omit the "Filesystem" header
/// by detecting whether the first token looks like a header.
pub fn parse_df(output: &str) -> Vec<DiskSample> {
    let mut result = Vec::new();
    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split_whitespace().collect();
        // Header line — skip
        if parts.first().is_some_and(|s| {
            s.eq_ignore_ascii_case("filesystem") || s.eq_ignore_ascii_case("s.filesystem")
        }) {
            continue;
        }
        // Minimum fields: Filesystem, 1K-blocks, Used, Available, Use%, Mounted
        if parts.len() < 6 {
            continue;
        }
        let filesystem = parts[0].to_string();
        // Skip virtual/noise filesystems
        if should_skip_filesystem(&filesystem) {
            continue;
        }
        // Use% is the 5th field (index 4) — strip the trailing '%'
        let use_pct_str = parts[4].trim_end_matches('%');
        let used_pct = use_pct_str.parse::<u8>().unwrap_or(0);
        let available_kb = parts[3].parse::<u64>().unwrap_or(0);
        result.push(DiskSample {
            filesystem,
            used_pct,
            available_kb,
        });
    }
    result
}

fn should_skip_filesystem(fs: &str) -> bool {
    matches!(
        fs,
        "tmpfs"
            | "devtmpfs"
            | "overlay"
            | "squashfs"
            | "udev"
            | "rootfs"
            | "devfs"
            | "sysfs"
            | "proc"
            | "cgroup"
            | "cgroupfs"
            | "none"
    ) || fs.starts_with("cgroup")
}

// ─── parse_ps ────────────────────────────────────────────────────────────────

/// Parse `ps -eo pid,user,pcpu,pmem,comm` output.
///
/// First line is assumed to be the header (PID USER ...) and is skipped.
/// Lines with fewer than 5 fields are skipped.
/// Returns an empty Vec on any failure (empty output, header-only, etc.).
pub fn parse_ps(output: &str) -> Vec<ProcessRow> {
    let mut result = Vec::new();
    let mut lines = output.lines().peekable();

    // Skip header
    if let Some(first) = lines.peek() {
        let upper = first.trim().to_ascii_uppercase();
        if upper.contains("PID") || upper.contains("USER") || upper.contains("COMMAND") {
            lines.next();
        }
    }

    for line in lines {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.splitn(5, char::is_whitespace).collect();
        // Collect non-empty after split
        let fields: Vec<&str> = parts.iter().flat_map(|s| s.split_whitespace()).collect();
        if fields.len() < 5 {
            continue;
        }
        let pid = match fields[0].parse::<u32>() {
            Ok(p) if p > 0 => p,
            _ => continue,
        };
        let user = fields[1].to_string();
        let cpu_pct = fields[2].parse::<f32>().unwrap_or(0.0);
        let mem_pct = fields[3].parse::<f32>().unwrap_or(0.0);
        let name = fields[4].to_string();
        result.push(ProcessRow {
            pid,
            user,
            cpu_pct,
            mem_pct,
            name,
        });
    }
    result
}

// ─── parse_combined ──────────────────────────────────────────────────────────

/// Parse the combined command output (split by ===SECTION=== markers).
///
/// Missing sections silently degrade to zeroes/empty — the sampler never sees
/// an error from a partial response.
pub fn parse_combined(output: &str) -> ParsedRaw {
    let (cpu_raw, mem_raw, net_raw, disk_raw, ps_raw) = split_combined(output);

    let cpu = parse_proc_stat(&cpu_raw);
    let mem = parse_meminfo(&mem_raw);
    let net = parse_net_dev(&net_raw);
    let disk = parse_df(&disk_raw);
    let processes = parse_ps(&ps_raw);

    ParsedRaw {
        cpu,
        mem,
        net,
        disk,
        processes,
    }
}

/// Split a combined output string into (stat, mem, net, disk, ps) sections.
/// Each section is the content after its ===MARKER=== line up to the next.
fn split_combined(output: &str) -> (String, String, String, String, String) {
    let mut stat = String::new();
    let mut mem = String::new();
    let mut net = String::new();
    let mut disk = String::new();
    let mut ps = String::new();

    #[derive(Clone, Copy)]
    enum Section {
        None,
        Stat,
        Mem,
        Net,
        Disk,
        Ps,
    }

    let mut current = Section::None;
    for line in output.lines() {
        let trimmed = line.trim();
        if let Some(key) = try_parse_section_marker(trimmed) {
            current = match key {
                "STAT" => Section::Stat,
                "MEM" => Section::Mem,
                "NET" => Section::Net,
                "DISK" => Section::Disk,
                "PS" => Section::Ps,
                _ => Section::None,
            };
            continue;
        }
        match current {
            Section::Stat => {
                stat.push_str(line);
                stat.push('\n');
            }
            Section::Mem => {
                mem.push_str(line);
                mem.push('\n');
            }
            Section::Net => {
                net.push_str(line);
                net.push('\n');
            }
            Section::Disk => {
                disk.push_str(line);
                disk.push('\n');
            }
            Section::Ps => {
                ps.push_str(line);
                ps.push('\n');
            }
            Section::None => {}
        }
    }

    (stat, mem, net, disk, ps)
}

/// Detect lines like `===STAT===`, `===MEM===`, etc. Returns the key inside.
fn try_parse_section_marker(line: &str) -> Option<&str> {
    let line = line.trim();
    if line.starts_with("===") && line.ends_with("===") && line.len() > 6 {
        Some(&line[3..line.len() - 3])
    } else {
        None
    }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── WU1: parse_proc_stat ─────────────────────────────────────────────────

    #[test]
    fn parse_proc_stat_extracts_total_and_idle() {
        // Realistic /proc/stat first line: user nice system idle iowait irq softirq
        let input = "cpu  7200 0 2400 86400 1200 100 50 0\ncpu0 3600 0 1200 43200 600 50 25 0\n";
        let raw = parse_proc_stat(input).expect("should parse");
        // total = 7200+0+2400+86400+1200+100+50+0 = 97350
        assert_eq!(raw.total, 97_350);
        // idle = idle + iowait = 86400 + 1200 = 87600
        assert_eq!(raw.idle, 87_600);
    }

    #[test]
    fn parse_proc_stat_minimal_four_fields() {
        // Some kernels report fewer fields
        let input = "cpu  100 0 50 850\n";
        let raw = parse_proc_stat(input).expect("should parse 4 fields");
        assert_eq!(raw.total, 1000);
        assert_eq!(raw.idle, 850);
    }

    #[test]
    fn parse_proc_stat_ignores_per_cpu_lines() {
        let input = "cpu0 1 0 1 100\ncpu  7200 0 2400 86400 0 0 0 0\n";
        let raw = parse_proc_stat(input).expect("should find aggregate cpu line");
        assert_eq!(raw.total, 96_000);
    }

    #[test]
    fn parse_proc_stat_returns_none_on_empty() {
        assert!(parse_proc_stat("").is_none());
    }

    #[test]
    fn parse_proc_stat_returns_none_on_no_cpu_line() {
        assert!(parse_proc_stat("cpu0 1 2 3 4\ncpu1 5 6 7 8\n").is_none());
    }

    // ── WU1: cpu_delta ───────────────────────────────────────────────────────

    #[test]
    fn cpu_delta_first_tick_same_values_returns_zero() {
        let r = CpuRaw {
            total: 1000,
            idle: 800,
        };
        assert_eq!(cpu_delta(&r, &r), 0.0);
    }

    #[test]
    fn cpu_delta_100_percent_when_no_idle_change() {
        let prev = CpuRaw {
            total: 1000,
            idle: 800,
        };
        let curr = CpuRaw {
            total: 1200,
            idle: 800,
        };
        // 200 total delta, 0 idle delta → 100%
        assert!((cpu_delta(&prev, &curr) - 100.0).abs() < 0.01);
    }

    #[test]
    fn cpu_delta_zero_when_all_idle() {
        let prev = CpuRaw {
            total: 1000,
            idle: 800,
        };
        let curr = CpuRaw {
            total: 1200,
            idle: 1000,
        };
        // 200 total, 200 idle → 0%
        assert_eq!(cpu_delta(&prev, &curr), 0.0);
    }

    #[test]
    fn cpu_delta_50_percent() {
        let prev = CpuRaw { total: 0, idle: 0 };
        let curr = CpuRaw {
            total: 200,
            idle: 100,
        };
        let pct = cpu_delta(&prev, &curr);
        assert!((pct - 50.0).abs() < 0.01, "expected ~50%, got {pct}");
    }

    #[test]
    fn cpu_delta_zero_on_total_wrap() {
        // If total decreased (counter wrap or error) saturating_sub gives 0 → 0%
        let prev = CpuRaw {
            total: 1000,
            idle: 800,
        };
        let curr = CpuRaw {
            total: 500,
            idle: 400,
        }; // "went backward"
        assert_eq!(cpu_delta(&prev, &curr), 0.0);
    }

    // ── WU1: parse_meminfo ───────────────────────────────────────────────────

    #[test]
    fn parse_meminfo_extracts_total_and_available() {
        let input = "MemTotal:       16384000 kB\nMemFree:         4096000 kB\nMemAvailable:    8192000 kB\n";
        let m = parse_meminfo(input);
        assert_eq!(m.total_kb, 16_384_000);
        assert_eq!(m.available_kb, 8_192_000);
    }

    #[test]
    fn parse_meminfo_usage_pct_correct() {
        let m = MemSample {
            total_kb: 16_384,
            available_kb: 8_192,
        };
        // used = 8192, pct = 50%
        let pct = m.usage_pct();
        assert!((pct - 50.0).abs() < 0.01, "expected 50%, got {pct}");
    }

    #[test]
    fn parse_meminfo_zero_on_missing_keys() {
        let m = parse_meminfo("SomeOtherKey: 1234 kB\n");
        assert_eq!(m.total_kb, 0);
        assert_eq!(m.available_kb, 0);
        assert_eq!(m.usage_pct(), 0.0);
    }

    #[test]
    fn meminfo_usage_pct_zero_when_total_zero() {
        let m = MemSample {
            total_kb: 0,
            available_kb: 0,
        };
        assert_eq!(m.usage_pct(), 0.0);
    }

    // ── WU1: parse_df ───────────────────────────────────────────────────────

    #[test]
    fn parse_df_basic() {
        let input = "Filesystem     1K-blocks     Used Available Use% Mounted on\n\
                     /dev/sda1       10485760  5242880   5242880  50% /\n\
                     tmpfs             524288        0    524288   0% /dev/shm\n";
        let disks = parse_df(input);
        assert_eq!(disks.len(), 1, "tmpfs should be filtered");
        assert_eq!(disks[0].filesystem, "/dev/sda1");
        assert_eq!(disks[0].used_pct, 50);
        assert_eq!(disks[0].available_kb, 5_242_880);
    }

    #[test]
    fn parse_df_no_header_busybox_style() {
        // busybox df sometimes omits the Filesystem header
        let input = "/dev/sda1       10485760  5242880   5242880  75% /\n";
        let disks = parse_df(input);
        assert_eq!(disks.len(), 1);
        assert_eq!(disks[0].used_pct, 75);
    }

    #[test]
    fn parse_df_empty_returns_empty() {
        assert!(parse_df("").is_empty());
        assert!(parse_df("Filesystem 1K-blocks Used Available Use% Mounted\n").is_empty());
    }

    #[test]
    fn parse_df_multiple_disks() {
        let input = "Filesystem     1K-blocks     Used Available Use% Mounted on\n\
                     /dev/sda1       10485760  5242880   5242880  50% /\n\
                     /dev/sdb1       20971520 10485760  10485760  50% /data\n";
        let disks = parse_df(input);
        assert_eq!(disks.len(), 2);
    }

    // ── WU1: parse_net_dev ──────────────────────────────────────────────────

    #[test]
    fn parse_net_dev_extracts_rx_and_tx() {
        let input = "Inter-|   Receive                                                |  Transmit\n\
                     face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n\
                     eth0:  12345678  9000 0 0 0 0 0 0  87654321  7000 0 0 0 0 0 0\n\
                       lo:    111111  1000 0 0 0 0 0 0    111111  1000 0 0 0 0 0 0\n";
        let ifaces = parse_net_dev(input);
        // lo should be excluded
        assert_eq!(ifaces.len(), 1);
        assert_eq!(ifaces[0].iface, "eth0");
        assert_eq!(ifaces[0].rx_bytes, 12_345_678);
        assert_eq!(ifaces[0].tx_bytes, 87_654_321);
    }

    #[test]
    fn parse_net_dev_empty_or_header_only() {
        let input = "Inter-|   Receive\n face |bytes\n";
        let ifaces = parse_net_dev(input);
        assert!(ifaces.is_empty());
    }

    #[test]
    fn net_delta_computes_bps() {
        let prev = vec![NetIfaceRaw {
            iface: "eth0".to_string(),
            rx_bytes: 0,
            tx_bytes: 0,
        }];
        let curr = vec![NetIfaceRaw {
            iface: "eth0".to_string(),
            rx_bytes: 3000,
            tx_bytes: 1000,
        }];
        // elapsed = 1 second → rx_bps=3000, tx_bps=1000
        let (rx, tx) = net_delta(&prev, &curr, 1.0);
        assert_eq!(rx, 3000);
        assert_eq!(tx, 1000);
    }

    #[test]
    fn net_delta_zero_when_elapsed_zero() {
        let iface = vec![NetIfaceRaw {
            iface: "eth0".to_string(),
            rx_bytes: 9999,
            tx_bytes: 9999,
        }];
        let (rx, tx) = net_delta(&iface, &iface, 0.0);
        assert_eq!(rx, 0);
        assert_eq!(tx, 0);
    }

    #[test]
    fn net_delta_ignores_missing_interface() {
        let prev = vec![NetIfaceRaw {
            iface: "eth0".to_string(),
            rx_bytes: 0,
            tx_bytes: 0,
        }];
        let curr = vec![NetIfaceRaw {
            iface: "eth1".to_string(),
            rx_bytes: 5000,
            tx_bytes: 5000,
        }];
        // eth1 appears in curr but not in prev — no delta available
        let (rx, tx) = net_delta(&prev, &curr, 1.0);
        assert_eq!(rx, 0);
        assert_eq!(tx, 0);
    }

    // ── WU1: parse_ps ───────────────────────────────────────────────────────

    #[test]
    fn parse_ps_basic() {
        let input = "  PID USER     %CPU %MEM COMMAND\n\
                         1 root      0.0  0.1 systemd\n\
                       123 www-data  1.5  0.8 nginx\n";
        let procs = parse_ps(input);
        assert_eq!(procs.len(), 2);
        assert_eq!(procs[0].pid, 1);
        assert_eq!(procs[0].user, "root");
        assert!((procs[0].cpu_pct - 0.0).abs() < 0.01);
        assert_eq!(procs[1].pid, 123);
        assert_eq!(procs[1].name, "nginx");
    }

    #[test]
    fn parse_ps_empty_returns_empty() {
        assert!(parse_ps("").is_empty());
    }

    #[test]
    fn parse_ps_header_only_returns_empty() {
        assert!(parse_ps("  PID USER %CPU %MEM COMMAND\n").is_empty());
    }

    #[test]
    fn parse_ps_skips_invalid_pid() {
        let input = "  PID USER %CPU %MEM COMMAND\nfoo root 0.0 0.1 bash\n";
        let procs = parse_ps(input);
        assert!(procs.is_empty(), "non-numeric PID must be skipped");
    }

    #[test]
    fn parse_ps_handles_process_with_spaces_in_name() {
        // In practice ps with 'comm' truncates at 15 chars and has no spaces,
        // but we confirm the 5th token is used as the name regardless.
        let input = "  PID USER %CPU %MEM COMMAND\n   42 root  5.0  1.0 kworker/0:1H\n";
        let procs = parse_ps(input);
        assert_eq!(procs.len(), 1);
        assert_eq!(procs[0].name, "kworker/0:1H");
    }

    // ── WU1: parse_combined ─────────────────────────────────────────────────

    #[test]
    fn parse_combined_all_sections_present() {
        let input = "\
===STAT===\n\
cpu  100 0 50 800 50 0 0 0\n\
===MEM===\n\
MemTotal:       16384 kB\n\
MemAvailable:    8192 kB\n\
===NET===\n\
Inter-|   Receive\n\
 face |bytes\n\
 eth0: 1000 10 0 0 0 0 0 0 500 5 0 0 0 0 0 0\n\
===DISK===\n\
Filesystem     1K-blocks Used Available Use% Mounted on\n\
/dev/sda1       10485760 5242880 5242880  50% /\n\
===PS===\n\
  PID USER %CPU %MEM COMMAND\n\
    1 root  0.0  0.1 systemd\n\
";
        let parsed = parse_combined(input);
        assert!(parsed.cpu.is_some(), "cpu should be parsed");
        assert_eq!(parsed.mem.total_kb, 16_384);
        assert_eq!(parsed.net.len(), 1);
        assert_eq!(parsed.disk.len(), 1);
        assert_eq!(parsed.processes.len(), 1);
    }

    #[test]
    fn parse_combined_missing_stat_section_degrades_gracefully() {
        let input = "\
===MEM===\n\
MemTotal: 8192 kB\n\
MemAvailable: 4096 kB\n\
===NET===\n\
===DISK===\n\
===PS===\n\
";
        let parsed = parse_combined(input);
        assert!(parsed.cpu.is_none(), "missing STAT → cpu is None");
        assert_eq!(parsed.mem.total_kb, 8192);
        assert!(parsed.net.is_empty());
        assert!(parsed.disk.is_empty());
        assert!(parsed.processes.is_empty());
    }

    #[test]
    fn parse_combined_empty_output_degrades_gracefully() {
        let parsed = parse_combined("");
        assert!(parsed.cpu.is_none());
        assert_eq!(parsed.mem.total_kb, 0);
        assert!(parsed.net.is_empty());
        assert!(parsed.disk.is_empty());
        assert!(parsed.processes.is_empty());
    }

    #[test]
    fn parse_combined_partial_garbage_in_sections_degrades() {
        let input = "\
===STAT===\n\
totally not a cpu line\n\
===MEM===\n\
garbage\n\
===NET===\n\
not a network line\n\
===DISK===\n\
garbage\n\
===PS===\n\
garbage\n\
";
        let parsed = parse_combined(input);
        assert!(parsed.cpu.is_none());
        assert_eq!(parsed.mem.total_kb, 0);
        assert!(parsed.net.is_empty());
        // disk parser might try to parse "garbage" — it should produce empty (< 6 fields)
        assert!(parsed.disk.is_empty());
        assert!(parsed.processes.is_empty());
    }
}
