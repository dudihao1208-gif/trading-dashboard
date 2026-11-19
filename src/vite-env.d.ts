/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_WORKER_URL?: string;
  readonly VITE_DASHBOARD_URL?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
