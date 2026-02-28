import type { PerMessageDeflateOptions } from "ws";

export const WS_DEFLATE_OPTIONS: PerMessageDeflateOptions = {
  zlibDeflateOptions: { level: 6 },
  threshold: 256,
};
