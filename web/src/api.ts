import { toB64 } from "./transport/socket";

export interface RoomMeta {
  exists: boolean;
  requires_auth: boolean;
  kdf: { alg: string; m_kib: number; t: number; p: number; salt: string };
}

export interface TtlBody {
  kind: "absolute" | "idle-edit" | "idle-peers" | "none";
  secs: number;
}

export interface CreateRoomResponse {
  ok: boolean;
  room_id: string;
  name?: string;
}

export class Api {
  constructor(private baseUrl: string) {}

  async metaUnlisted(roomIdHex: string): Promise<RoomMeta> {
    const res = await fetch(`${this.baseUrl}/api/meta/id/${roomIdHex}`);
    if (res.status === 429) throw new ApiError("RATE_LIMITED");
    if (!res.ok) throw new ApiError("META_FAILED");
    return res.json() as Promise<RoomMeta>;
  }

  async resolveName(name: string): Promise<{ found: boolean; name?: string; room_id?: string; requires_auth?: boolean; kdf?: RoomMeta["kdf"] }> {
    const res = await fetch(`${this.baseUrl}/api/names/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (res.status === 429) throw new ApiError("RATE_LIMITED");
    if (res.status === 400) throw new ApiError("NAME_INVALID");
    if (!res.ok) throw new ApiError("RESOLVE_FAILED");
    return res.json() as Promise<{ found: boolean; name?: string; room_id?: string; requires_auth?: boolean; kdf?: RoomMeta["kdf"] }>;
  }

  async createUnlisted(args: {
    verifierB64: string;
    kdf: { m_kib: number; t: number; p: number; salt: string };
    ttl: TtlBody;
    ceilingOptout: boolean;
    configBlob?: Uint8Array;
  }): Promise<CreateRoomResponse> {
    const res = await fetch(`${this.baseUrl}/api/rooms/unlisted`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        verifier: args.verifierB64,
        kdf: args.kdf,
        ttl: args.ttl,
        ceiling_optout: args.ceilingOptout,
        ...(args.configBlob ? { config_blob: toB64(args.configBlob) } : {}),
      }),
    });
    if (res.status === 409) throw new ApiError("UNAVAILABLE");
    if (res.status === 429) throw new ApiError("RATE_LIMITED");
    if (res.status === 503) throw new ApiError(await unavailableCode(res));
    if (res.status === 413) throw new ApiError("CONFIG_TOO_LARGE");
    if (!res.ok) throw new ApiError("CREATE_FAILED");
    return res.json() as Promise<CreateRoomResponse>;
  }

  /// Present a restart ticket to the process that replaced the one which
  /// issued it. Throws only when the request never reached the server, which
  /// the caller retries like a 503.
  async restoreRoom(ticket: string): Promise<"restored" | "retry" | "gone" | "name-taken"> {
    const res = await fetch(`${this.baseUrl}/api/rooms/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticket }),
    });
    if (res.status === 200 || res.status === 201) return "restored";
    if (res.status === 409) return "name-taken";
    if (res.status === 400 || res.status === 410) return "gone";
    return "retry";
  }

  async createNamed(args: {
    name: string;
    suffix: boolean;
    verifierB64: string;
    kdf: { m_kib: number; t: number; p: number; salt: string };
    ttl: TtlBody;
    ceilingOptout: boolean;
    configBlob?: Uint8Array;
  }): Promise<CreateRoomResponse> {
    const res = await fetch(`${this.baseUrl}/api/rooms/named`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: args.name,
        suffix: args.suffix,
        verifier: args.verifierB64,
        kdf: args.kdf,
        ttl: args.ttl,
        ceiling_optout: args.ceilingOptout,
        ...(args.configBlob ? { config_blob: toB64(args.configBlob) } : {}),
      }),
    });
    if (res.status === 409) throw new ApiError("NAME_TAKEN");
    if (res.status === 422) throw new ApiError("PASSPHRASE_REQUIRED");
    if (res.status === 400) throw new ApiError("NAME_INVALID");
    if (res.status === 429) throw new ApiError("RATE_LIMITED");
    if (res.status === 503) throw new ApiError(await unavailableCode(res));
    if (res.status === 413) throw new ApiError("CONFIG_TOO_LARGE");
    if (!res.ok) throw new ApiError("CREATE_FAILED");
    return res.json() as Promise<CreateRoomResponse>;
  }
}

/// A 503 means one of two things, and they call for different advice.
async function unavailableCode(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { code?: unknown } | null;
  return body?.code === "RESTARTING" ? "RESTARTING" : "AT_CAPACITY";
}

export class ApiError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

export function randomRoomIdHex(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
