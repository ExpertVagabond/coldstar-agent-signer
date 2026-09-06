#!/usr/bin/env python3
"""Sign a Coldstar policy envelope on the air-gapped machine, with no dependencies.

A machine that earns the name "air-gapped" is usually a minimal install or a
read-only live image. Those have python3; they often do not have Node, and
`pip install` needs the network you just removed. So this is a single file that
runs on a stock Python 3.8+ and produces exactly what the TypeScript signer
produces. The wire format is in ENVELOPE-SPEC.md; the two are cross-verified in
src/policy/crossLanguage.test.ts.

    ./coldstar_sign_policy.py --root root.json --policy coldstar.policy.json \\
        --session <session pubkey> --expires 7d [--revoker <pubkey>] > envelope.json

Signing uses PyNaCl when it is installed, and otherwise a vendored Ed25519 from
RFC 8032. See the note above sign_ed25519 for why that fallback is acceptable
here and where it would not be.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import socket
import sys
from datetime import datetime, timedelta, timezone

# ---------------------------------------------------------------- base58

_B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def b58encode(data: bytes) -> str:
    n = int.from_bytes(data, "big")
    out = ""
    while n > 0:
        n, r = divmod(n, 58)
        out = _B58[r] + out
    for b in data:
        if b != 0:
            break
        out = "1" + out
    return out or "1"


def b58decode(s: str) -> bytes:
    n = 0
    for c in s:
        i = _B58.find(c)
        if i < 0:
            raise ValueError(f"invalid base58 character {c!r}")
        n = n * 58 + i
    body = n.to_bytes((n.bit_length() + 7) // 8, "big") if n else b""
    pad = len(s) - len(s.lstrip("1"))
    return b"\x00" * pad + body


# ---------------------------------------------------------------- canonical JSON


def canonical(value) -> str:
    """Sorted keys, no whitespace. Must match the TypeScript canonical()."""
    if isinstance(value, dict):
        return "{" + ",".join(
            json.dumps(k, ensure_ascii=False) + ":" + canonical(v) for k, v in sorted(value.items())
        ) + "}"
    if isinstance(value, list):
        return "[" + ",".join(canonical(v) for v in value) + "]"
    if value is True or value is False or value is None or isinstance(value, (int, float)):
        return json.dumps(value)
    return json.dumps(value, ensure_ascii=False)


# ---------------------------------------------------------------- Ed25519
#
# PyNaCl (libsodium) is used when available: it is constant-time and audited.
#
# The fallback is the RFC 8032 reference implementation. It is NOT constant-time,
# so it leaks timing information to an attacker who can observe the process. On
# the machine this is meant for — air-gapped, single-purpose, no attacker
# present to observe — that is an acceptable trade for not needing the network
# to install a dependency. Do not lift this function into anything online.

_q = 2 ** 255 - 19
_L = 2 ** 252 + 27742317777372353535851937790883648493
_d = -121665 * pow(121666, _q - 2, _q) % _q
_I = pow(2, (_q - 1) // 4, _q)


def _xrecover(y: int) -> int:
    xx = (y * y - 1) * pow(_d * y * y + 1, _q - 2, _q)
    x = pow(xx, (_q + 3) // 8, _q)
    if (x * x - xx) % _q != 0:
        x = (x * _I) % _q
    if x % 2 != 0:
        x = _q - x
    return x


_By = 4 * pow(5, _q - 2, _q) % _q
_B = (_xrecover(_By) % _q, _By % _q, 1, _xrecover(_By) * _By % _q)


def _add(p, r):
    x1, y1, z1, t1 = p
    x2, y2, z2, t2 = r
    a = (y1 - x1) * (y2 - x2) % _q
    b = (y1 + x1) * (y2 + x2) % _q
    c = t1 * 2 * _d * t2 % _q
    dd = z1 * 2 * z2 % _q
    e, f, g, h = b - a, dd - c, dd + c, b + a
    return (e * f % _q, g * h % _q, f * g % _q, e * h % _q)


def _double(p):
    return _add(p, p)


def _scalarmult(p, e: int):
    if e == 0:
        return (0, 1, 1, 0)
    r = _scalarmult(p, e // 2)
    r = _double(r)
    if e & 1:
        r = _add(r, p)
    return r


def _encodepoint(p) -> bytes:
    x, y, z, _t = p
    zi = pow(z, _q - 2, _q)
    x, y = x * zi % _q, y * zi % _q
    return ((y & ~(1 << 255)) | ((x & 1) << 255)).to_bytes(32, "little")


def _hint(m: bytes) -> int:
    return int.from_bytes(hashlib.sha512(m).digest(), "little")


def _sign_pure(message: bytes, secret64: bytes) -> bytes:
    seed, public = secret64[:32], secret64[32:]
    h = hashlib.sha512(seed).digest()
    a = (1 << 254) + (int.from_bytes(h[:32], "little") & ((1 << 254) - 8))
    r = _hint(h[32:64] + message)
    big_r = _scalarmult(_B, r)
    enc_r = _encodepoint(big_r)
    s = (r + _hint(enc_r + public + message) * a) % _L
    return enc_r + s.to_bytes(32, "little")


def sign_ed25519(message: bytes, secret64: bytes) -> bytes:
    """Detached Ed25519 signature. secret64 is the 64-byte Solana keypair."""
    try:
        from nacl.signing import SigningKey  # type: ignore

        return bytes(SigningKey(secret64[:32]).sign(message).signature)
    except ImportError:
        return _sign_pure(message, secret64)


def using_pynacl() -> bool:
    try:
        import nacl.signing  # noqa: F401  # type: ignore

        return True
    except ImportError:
        return False


# ---------------------------------------------------------------- air gap


def active_interfaces() -> list[str]:
    """Best-effort: addresses this host answers on, excluding loopback.

    Matches the intent of src/policy/airgap.ts. Like that check, an empty result
    is not proof of isolation — it is a reliable negative signal only.
    """
    found = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None):
            addr = info[4][0]
            if not addr.startswith("127.") and addr not in ("::1", "localhost"):
                found.add(addr)
    except OSError:
        pass
    try:  # a route to a public address means a live path, without sending anything
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.1)
        s.connect(("8.8.8.8", 80))
        found.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    return sorted(found)


# ---------------------------------------------------------------- policy


REQUIRED = ["version", "limits", "allowPrograms", "allowRecipients", "allowTokens", "blockRecipients", "escalateAboveSol"]
OPTIONAL = ["tokenLimits", "allowTokenAccounts"]


def check_policy(policy: dict) -> None:
    if not isinstance(policy, dict):
        die("policy must be an object")
    missing = [k for k in REQUIRED if k not in policy]
    if missing:
        die(f"policy is missing {', '.join(missing)}")
    unknown = [k for k in policy if k not in REQUIRED + OPTIONAL]
    if unknown:
        die(f"policy has unknown key(s): {', '.join(unknown)}")
    if policy["version"] != 1:
        die(f"unsupported policy version {policy['version']}")
    for key in ("allowRecipients", "blockRecipients"):
        for v in policy[key]:
            if v.startswith("<") or v.startswith("$"):
                die(f"policy.{key} still has the placeholder {v!r}")


def die(msg: str) -> "None":
    sys.stderr.write(f"coldstar_sign_policy: {msg}\n")
    raise SystemExit(2)


def parse_expiry(v: str) -> datetime:
    if v.endswith("h") and v[:-1].isdigit():
        return datetime.now(timezone.utc) + timedelta(hours=int(v[:-1]))
    if v.endswith("d") and v[:-1].isdigit():
        return datetime.now(timezone.utc) + timedelta(days=int(v[:-1]))
    try:
        d = datetime.fromisoformat(v.replace("Z", "+00:00"))
    except ValueError:
        die(f"--expires: cannot parse {v!r} (use 24h, 7d, or ISO-8601)")
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def iso(d: datetime) -> str:
    return d.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def main() -> int:
    ap = argparse.ArgumentParser(description="Sign a Coldstar policy envelope offline.")
    ap.add_argument("--root", required=True, help="root keyfile (solana-keygen JSON byte array)")
    ap.add_argument("--policy", default="coldstar.policy.json")
    ap.add_argument("--session", required=True, help="session public key, base58")
    ap.add_argument("--expires", help="24h, 7d, or ISO-8601")
    ap.add_argument("--revoker", help="hot key allowed to revoke this grant on chain (emits version 2)")
    ap.add_argument("--allow-network", action="store_true", help="override the air-gap check (do not, for a real root)")
    args = ap.parse_args()

    nics = active_interfaces()
    if nics and not args.allow_network:
        sys.stderr.write(
            f"coldstar_sign_policy: THIS MACHINE HAS A LIVE NETWORK PATH: {', '.join(nics[:4])}"
            + (f" and {len(nics) - 4} more" if len(nics) > 4 else "")
            + "\nRefusing to read the root key on a networked machine. Move to the offline machine, or pass\n"
            "--allow-network if you have decided this is acceptable (it is not, for a real root key).\n"
        )
        return 3
    if nics:
        sys.stderr.write("coldstar_sign_policy: WARNING — signing the root key on a NETWORKED machine (--allow-network).\n")

    with open(args.root, "r", encoding="utf-8") as f:
        secret = bytes(json.load(f))
    if len(secret) != 64:
        die(f"--root: expected a 64-byte keypair, got {len(secret)} bytes")
    with open(args.policy, "r", encoding="utf-8") as f:
        policy = json.load(f)
    check_policy(policy)

    try:
        if len(b58decode(args.session)) != 32:
            die("--session: not a 32-byte public key")
    except ValueError as e:
        die(f"--session: {e}")

    version = 2 if args.revoker is not None else 1
    issued_at = iso(datetime.now(timezone.utc))
    expires_at = iso(parse_expiry(args.expires)) if args.expires else None

    payload = {"policy": policy, "sessionPubkey": args.session, "issuedAt": issued_at, "expiresAt": expires_at}
    if version == 2:
        payload["revoker"] = args.revoker
    signature = sign_ed25519(canonical(payload).encode("utf-8"), secret)

    envelope = {
        "version": version,
        "policy": policy,
        "sessionPubkey": args.session,
        "issuedAt": issued_at,
        "expiresAt": expires_at,
    }
    if version == 2:
        envelope["revoker"] = args.revoker
    envelope["rootPubkey"] = b58encode(secret[32:])
    envelope["signature"] = b58encode(signature)

    sys.stdout.write(json.dumps(envelope, indent=2) + "\n")
    sys.stderr.write(
        f"signed by root {envelope['rootPubkey']} for session {args.session}"
        + (f", expires {expires_at}" if expires_at else ", no expiry (consider --expires)")
        + (f", revocable by {args.revoker}" if args.revoker else "")
        + f"\nbackend: {'PyNaCl' if using_pynacl() else 'vendored RFC 8032 (not constant-time; air-gapped use only)'}\n"
        + f"air gap: {'no active network addresses' if not nics else 'NETWORKED'}\n"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
