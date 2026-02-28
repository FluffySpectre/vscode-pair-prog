interface InviteData {
  a?: string;  // address (IP:PORT) - LAN invites
  r?: string;  // relay server URL - relay invites
  c?: string;  // relay session code - relay invites
  p?: boolean; // requiresPassphrase
}

export type DecodedInvite =
  | { type: "lan"; address: string; requiresPassphrase: boolean }
  | { type: "relay"; relayUrl: string; code: string; requiresPassphrase: boolean };

export function encodeInviteCode(address: string, requiresPassphrase: boolean): string {
  const data: InviteData = { a: address };
  if (requiresPassphrase) { data.p = true; }
  return Buffer.from(JSON.stringify(data)).toString("base64url");
}

export function encodeRelayInviteCode(relayUrl: string, code: string, requiresPassphrase: boolean): string {
  const data: InviteData = { r: relayUrl, c: code };
  if (requiresPassphrase) { data.p = true; }
  return Buffer.from(JSON.stringify(data)).toString("base64url");
}

export function decodeInviteCode(code: string): DecodedInvite {
  let data: InviteData;
  try {
    data = JSON.parse(Buffer.from(code, "base64url").toString());
  } catch {
    throw new Error("Invalid invite code.");
  }
  if (data.r && data.c) {
    return { type: "relay", relayUrl: data.r, code: data.c, requiresPassphrase: !!data.p };
  }
  if (data.a) {
    return { type: "lan", address: data.a, requiresPassphrase: !!data.p };
  }
  throw new Error("Invalid invite code: missing connection info.");
}
