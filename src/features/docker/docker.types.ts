// features/docker/docker.types.ts — Docker feature type aliases
//
// Re-exports store types for use in DockerPanel and related components
// without coupling them directly to the store import path.

export type { ContainerRow, DockerAction } from "../../stores/dockerStore";
