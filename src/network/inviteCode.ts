interface InviteData {
  a: string;  // address (IP:PORT)
  p?: boolean; // requiresPassphrase
}

export function encodeInviteCode(address: string, requiresPassphrase: boolean): string {
  const data: InviteData = { a: address };
  if (requiresPassphrase) { data.p = true; }
  return Buffer.from(JSON.stringify(data)).toString("base64url");
}

export function decodeInviteCode(code: string): {
  address: string;
  requiresPassphrase: boolean;
} {
  let data: InviteData;
  try {
    data = JSON.parse(Buffer.from(code, "base64url").toString());
  } catch {
    throw new Error("Invalid invite code.");
  }
  if (!data.a) {
    throw new Error("Invalid invite code: missing address.");
  }
  return { address: data.a, requiresPassphrase: !!data.p };
}
