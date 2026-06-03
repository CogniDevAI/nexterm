// stores/editorStore.test.ts — TDD: per-session in-app file editor state store

import { describe, it, expect, beforeEach } from "vitest";
import { useEditorStore } from "./editorStore";

function resetStore() {
  useEditorStore.setState({
    docs: new Map(),
    activeDocs: new Map(),
  });
}

function makeKey(sessionId: string, source: "local" | "remote", path: string) {
  return `${sessionId}:${source}:${path}`;
}

describe("editorStore — openDoc", () => {
  beforeEach(resetStore);

  it("adds a new doc with loading state", () => {
    useEditorStore.getState().openDoc({ sessionId: "s1", source: "remote", path: "/etc/hosts", name: "hosts" });
    const key = makeKey("s1", "remote", "/etc/hosts");
    const doc = useEditorStore.getState().docs.get(key);
    expect(doc).toBeDefined();
    expect(doc!.loading).toBe(true);
    expect(doc!.content).toBe("");
    expect(doc!.savedContent).toBe("");
  });

  it("dedupes by key — second open does not create a second doc", () => {
    const { openDoc } = useEditorStore.getState();
    openDoc({ sessionId: "s1", source: "remote", path: "/etc/hosts", name: "hosts" });
    openDoc({ sessionId: "s1", source: "remote", path: "/etc/hosts", name: "hosts" });
    expect(useEditorStore.getState().docs.size).toBe(1);
  });

  it("different paths produce separate docs", () => {
    const { openDoc } = useEditorStore.getState();
    openDoc({ sessionId: "s1", source: "remote", path: "/etc/hosts", name: "hosts" });
    openDoc({ sessionId: "s1", source: "remote", path: "/etc/fstab", name: "fstab" });
    expect(useEditorStore.getState().docs.size).toBe(2);
  });

  it("sets the new doc as active for the session", () => {
    useEditorStore.getState().openDoc({ sessionId: "s1", source: "remote", path: "/etc/hosts", name: "hosts" });
    const key = makeKey("s1", "remote", "/etc/hosts");
    expect(useEditorStore.getState().activeDocs.get("s1")).toBe(key);
  });

  it("source=local and source=remote on the same path are separate docs", () => {
    const { openDoc } = useEditorStore.getState();
    openDoc({ sessionId: "s1", source: "local", path: "/tmp/foo.txt", name: "foo.txt" });
    openDoc({ sessionId: "s1", source: "remote", path: "/tmp/foo.txt", name: "foo.txt" });
    expect(useEditorStore.getState().docs.size).toBe(2);
  });
});

describe("editorStore — setContent", () => {
  beforeEach(resetStore);

  it("sets content on an existing doc", () => {
    const key = makeKey("s1", "remote", "/etc/hosts");
    useEditorStore.getState().openDoc({ sessionId: "s1", source: "remote", path: "/etc/hosts", name: "hosts" });
    useEditorStore.getState().setContent(key, "127.0.0.1 localhost");
    expect(useEditorStore.getState().docs.get(key)!.content).toBe("127.0.0.1 localhost");
  });

  it("setContent makes the doc dirty (content !== savedContent)", () => {
    const key = makeKey("s1", "remote", "/etc/hosts");
    useEditorStore.getState().openDoc({ sessionId: "s1", source: "remote", path: "/etc/hosts", name: "hosts" });
    useEditorStore.getState().markSaved(key, "original");
    useEditorStore.getState().setContent(key, "changed");
    const doc = useEditorStore.getState().docs.get(key)!;
    expect(doc.content).toBe("changed");
    expect(doc.savedContent).toBe("original");
    expect(doc.content !== doc.savedContent).toBe(true);
  });
});

describe("editorStore — markSaved", () => {
  beforeEach(resetStore);

  it("markSaved sets savedContent = content, clears saving/error", () => {
    const key = makeKey("s1", "remote", "/etc/hosts");
    useEditorStore.getState().openDoc({ sessionId: "s1", source: "remote", path: "/etc/hosts", name: "hosts" });
    useEditorStore.getState().setContent(key, "new content");
    useEditorStore.getState().markSaved(key, "new content");
    const doc = useEditorStore.getState().docs.get(key)!;
    expect(doc.savedContent).toBe("new content");
    expect(doc.saving).toBe(false);
    expect(doc.error).toBeNull();
  });

  it("doc is clean (not dirty) after markSaved with matching content", () => {
    const key = makeKey("s1", "remote", "/etc/hosts");
    useEditorStore.getState().openDoc({ sessionId: "s1", source: "remote", path: "/etc/hosts", name: "hosts" });
    useEditorStore.getState().setContent(key, "abc");
    useEditorStore.getState().markSaved(key, "abc");
    const doc = useEditorStore.getState().docs.get(key)!;
    expect(doc.content === doc.savedContent).toBe(true);
  });
});

describe("editorStore — setSaving / setError", () => {
  beforeEach(resetStore);

  it("setSaving sets the saving flag", () => {
    const key = makeKey("s1", "remote", "/etc/hosts");
    useEditorStore.getState().openDoc({ sessionId: "s1", source: "remote", path: "/etc/hosts", name: "hosts" });
    useEditorStore.getState().setSaving(key, true);
    expect(useEditorStore.getState().docs.get(key)!.saving).toBe(true);
  });

  it("setError records error string", () => {
    const key = makeKey("s1", "remote", "/etc/hosts");
    useEditorStore.getState().openDoc({ sessionId: "s1", source: "remote", path: "/etc/hosts", name: "hosts" });
    useEditorStore.getState().setError(key, "Binary file cannot be previewed");
    expect(useEditorStore.getState().docs.get(key)!.error).toBe("Binary file cannot be previewed");
  });
});

describe("editorStore — closeDoc", () => {
  beforeEach(resetStore);

  it("removes the doc from the store", () => {
    const { openDoc, closeDoc } = useEditorStore.getState();
    openDoc({ sessionId: "s1", source: "remote", path: "/etc/hosts", name: "hosts" });
    const key = makeKey("s1", "remote", "/etc/hosts");
    closeDoc(key, "s1");
    expect(useEditorStore.getState().docs.has(key)).toBe(false);
  });

  it("picks another doc as active when closing the active doc", () => {
    const { openDoc, closeDoc } = useEditorStore.getState();
    openDoc({ sessionId: "s1", source: "remote", path: "/etc/hosts", name: "hosts" });
    openDoc({ sessionId: "s1", source: "remote", path: "/etc/fstab", name: "fstab" });
    const key1 = makeKey("s1", "remote", "/etc/hosts");
    const key2 = makeKey("s1", "remote", "/etc/fstab");
    // key2 is active (last opened)
    closeDoc(key2, "s1");
    // should fall back to key1
    expect(useEditorStore.getState().activeDocs.get("s1")).toBe(key1);
  });

  it("sets active to null when closing the only doc", () => {
    const { openDoc, closeDoc } = useEditorStore.getState();
    openDoc({ sessionId: "s1", source: "remote", path: "/etc/hosts", name: "hosts" });
    const key = makeKey("s1", "remote", "/etc/hosts");
    closeDoc(key, "s1");
    expect(useEditorStore.getState().activeDocs.get("s1")).toBeNull();
  });

  it("does not affect docs from another session", () => {
    const { openDoc, closeDoc } = useEditorStore.getState();
    openDoc({ sessionId: "s1", source: "remote", path: "/etc/hosts", name: "hosts" });
    openDoc({ sessionId: "s2", source: "remote", path: "/etc/hosts", name: "hosts" });
    const key1 = makeKey("s1", "remote", "/etc/hosts");
    closeDoc(key1, "s1");
    const key2 = makeKey("s2", "remote", "/etc/hosts");
    expect(useEditorStore.getState().docs.has(key2)).toBe(true);
  });
});

describe("editorStore — setActiveDoc", () => {
  beforeEach(resetStore);

  it("setActiveDoc changes the active doc for a session", () => {
    const { openDoc, setActiveDoc } = useEditorStore.getState();
    openDoc({ sessionId: "s1", source: "remote", path: "/etc/hosts", name: "hosts" });
    openDoc({ sessionId: "s1", source: "remote", path: "/etc/fstab", name: "fstab" });
    const key1 = makeKey("s1", "remote", "/etc/hosts");
    setActiveDoc("s1", key1);
    expect(useEditorStore.getState().activeDocs.get("s1")).toBe(key1);
  });
});

describe("editorStore — selector stability", () => {
  beforeEach(resetStore);

  it("docs Map reference is stable when nothing changes", () => {
    const docs1 = useEditorStore.getState().docs;
    const docs2 = useEditorStore.getState().docs;
    expect(docs1).toBe(docs2);
  });

  it("activeDocs Map reference is stable when nothing changes", () => {
    const ad1 = useEditorStore.getState().activeDocs;
    const ad2 = useEditorStore.getState().activeDocs;
    expect(ad1).toBe(ad2);
  });
});
