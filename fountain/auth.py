"""Local, shared-family, and individual member authentication."""
from __future__ import annotations

import hashlib
import hmac
import os
import re
import secrets
import threading
import time
from collections import deque
from datetime import datetime, timedelta, timezone
from http.cookies import CookieError, SimpleCookie

from .core import APIError, require

SESSION_COOKIE = "fountain_session"
COOKIE_ATTRIBUTES = "HttpOnly; SameSite=Strict; Path=/"
SESSION_SECONDS = 7 * 24 * 60 * 60


class Auth:
    """Store session hashes; accept a shared secret only at login."""
    def __init__(self, store):
        self.store = store
        self._secret = os.environ.get("FOUNTAIN_ACCESS_TOKEN", "")
        require(not self._secret or len(self._secret) >= 16,
                "FOUNTAIN_ACCESS_TOKEN must contain at least 16 characters", 503)
        self._attempts = {}
        self._attempt_lock = threading.Lock()

    @property
    def enabled(self):
        return bool(self._secret) or self.accounts_required

    @property
    def accounts_required(self):
        return self.store.meta("auth_accounts_required", False) is True

    @staticmethod
    def _safe(member):
        return {key: member.get(key, True if key == "active" else None)
                for key in ("id", "name", "email", "role", "active")}

    def list_accounts(self):
        return [{**self._safe(member), "has_account": self.store.get("credential", member["id"]) is not None}
                for member in self.store.list("member")]

    @staticmethod
    def _password_hash(password, salt):
        return hashlib.scrypt(password.encode(), salt=salt, n=16384, r=8, p=1, dklen=32).hex()

    def _member(self, member_id):
        member = self.store.get("member", member_id)
        return member if member and member.get("active", True) is True and member.get("role") in {"owner", "admin", "member", "guest"} else None

    def _revoke(self, member_id=None):
        for session in self.store.list("session"):
            if member_id is None or session.get("member_id") == member_id:
                self.store.delete("session", session["id"])

    def create_account(self, member_id, password):
        with self.store.transaction():
            require(self.store.get("credential", member_id) is None, "Account already exists", 409)
            return self.set_password(member_id, password)

    def set_password(self, member_id, password):
        require(isinstance(password, str) and 10 <= len(password) <= 1024,
                "Password must contain between 10 and 1024 characters")
        with self.store.transaction():
            member = self._member(member_id)
            require(member is not None, "Active member not found", 404)
            email = member.get("email")
            require(isinstance(email, str) and "@" in email and len(email) <= 254, "Member needs a valid email")
            email = email.strip().casefold()
            require(not any(other["id"] != member_id and isinstance(other.get("email"), str)
                            and other["email"].strip().casefold() == email and other.get("active", True) is True
                            and self.store.get("credential", other["id"]) for other in self.store.list("member")),
                    "Another active account uses this email", 409)
            salt = secrets.token_bytes(32)
            self.store.put("credential", {"id": member_id, "salt": salt.hex(),
                "password_hash": self._password_hash(password, salt), "algorithm": "scrypt"})
            self._revoke(member_id)
            return {**self._safe(member), "has_account": True}

    def _owners(self):
        return [member for member in self.store.list("member") if member.get("role") == "owner"
                and self._member(member["id"]) and self.store.get("credential", member["id"])]

    def remove_account(self, member_id):
        with self.store.transaction():
            require(self.store.get("credential", member_id), "Account not found", 404)
            owners = self._owners()
            require(not self.accounts_required or any(member["id"] != member_id for member in owners),
                    "Cannot remove the last active owner account", 409)
            self.store.delete("credential", member_id)
            self._revoke(member_id)
            member = self.store.get("member", member_id)
            return {**self._safe(member), "has_account": False} if member else {"id": member_id, "has_account": False}

    def enable_accounts(self):
        with self.store.transaction():
            require(self._owners(), "Create an active owner account first", 409)
            self.store.set_meta("auth_accounts_required", True)
            self._revoke()
        return {"required": True, "mode": "accounts"}

    @staticmethod
    def _account_tag(digest, credential):
        material = (credential["salt"] + credential["password_hash"]).encode()
        return hmac.new(material, digest.encode(), hashlib.sha256).hexdigest()

    def _account_login(self, body):
        email, password = body.get("email"), body.get("password")
        well_formed = isinstance(email, str) and len(email) <= 254 and isinstance(password, str) and len(password) <= 1024
        matches = [member for member in self.store.list("member") if well_formed and self._member(member["id"])
                   and self.store.get("credential", member["id"])
                   and isinstance(member.get("email"), str)
                   and member["email"].strip().casefold() == email.strip().casefold()]
        member = self._member(matches[0]["id"]) if len(matches) == 1 else None
        credential = self.store.get("credential", member["id"]) if member else None
        try:
            salt = bytes.fromhex(credential["salt"]) if credential else b"fountain-missing-account-salt-32!"
            expected = credential["password_hash"] if credential else "0" * 64
            derived = self._password_hash(password if well_formed else "invalid", salt)
            valid = credential is not None and hmac.compare_digest(derived, expected)
        except (KeyError, ValueError, TypeError):
            valid = False
        require(valid, "Email or password is incorrect", 401)
        return member, credential

    def _limit(self, client):
        current = time.monotonic()
        with self._attempt_lock:
            # Discard inactive clients to keep this process-local limiter bounded.
            if len(self._attempts) >= 1000:
                self._attempts = {key: stamps for key, stamps in self._attempts.items()
                                  if stamps and stamps[-1] > current - 60}
                require(client in self._attempts or len(self._attempts) < 1000,
                        "Too many login attempts. Try again in a minute.", 429)
            attempts = self._attempts.setdefault(client, deque())
            while attempts and attempts[0] <= current - 60:
                attempts.popleft()
            require(len(attempts) < 10, "Too many login attempts. Try again in a minute.", 429)
            attempts.append(current)

    def _tag(self, digest):
        return hmac.new(self._secret.encode(), digest.encode(), hashlib.sha256).hexdigest()

    def login(self, body, client="local"):
        account_login = self.accounts_required or isinstance(body, dict) and ("email" in body or "password" in body)
        require(self.enabled or account_login, "Login is unnecessary in local mode", 409)
        self._limit(client)
        member, credential = None, None
        if account_login:
            member, credential = self._account_login(body if isinstance(body, dict) else {})
        else:
            require(isinstance(body, dict) and isinstance(body.get("token"), str)
                    and len(body["token"]) <= 4096, "A valid access token is required", 400)
            require(hmac.compare_digest(body["token"].encode(), self._secret.encode()), "Access token is incorrect", 401)
        token = secrets.token_urlsafe(32)
        digest = hashlib.sha256(token.encode()).hexdigest()
        expires = datetime.now(timezone.utc) + timedelta(seconds=SESSION_SECONDS)
        with self.store.transaction():
            current = datetime.now(timezone.utc).isoformat()
            for session in self.store.list("session"):
                if session.get("expires_at", "") <= current:
                    self.store.delete("session", session["id"])
            session = {"id": digest, "expires_at": expires.isoformat(), 'cache_binding': secrets.token_hex(16),
                       "credential_tag": self._account_tag(digest, credential) if member else self._tag(digest)}
            if member: session["member_id"] = member["id"]
            self.store.put("session", session)
        return token

    @staticmethod
    def _digest(cookie):
        if not isinstance(cookie, str) or len(cookie) > 8192:
            return None
        # Reject duplicate session names instead of selecting one ambiguously.
        if sum(part.strip().startswith(SESSION_COOKIE + "=") for part in cookie.split(";")) != 1:
            return None
        try:
            parsed = SimpleCookie()
            parsed.load(cookie)
            token = parsed[SESSION_COOKIE].value
        except (CookieError, KeyError):
            return None
        if not re.fullmatch(r"[A-Za-z0-9_-]{43}", token):
            return None
        return hashlib.sha256(token.encode()).hexdigest()

    def _session(self, cookie):
        return self.session_by_digest(self._digest(cookie))

    def session_by_digest(self, digest):
        """Validate a private session reference without retaining its raw cookie."""
        if not isinstance(digest, str) or re.fullmatch(r"[a-f0-9]{64}", digest) is None:
            return None
        session = self.store.get("session", digest)
        if not session:
            return None
        try:
            if session.get("member_id"):
                member = self._member(session["member_id"])
                credential = self.store.get("credential", session["member_id"])
                expected = self._account_tag(digest, credential) if credential and member else None
            else:
                expected = self._tag(digest) if self._secret and not self.accounts_required else None
            valid = (expected is not None and datetime.fromisoformat(session["expires_at"]) > datetime.now(timezone.utc)
                     and hmac.compare_digest(session.get("credential_tag", ""), expected))
        except (ValueError, TypeError, KeyError):
            valid = False
        if not valid:
            self.store.delete("session", digest)
            return None
        return session

    def principal_by_digest(self, digest):
        """Resolve the current actor of a validated private session reference."""
        session = self.session_by_digest(digest)
        if not session: return None
        if session.get("member_id"):
            member = self._member(session["member_id"])
            return self._safe(member) if member else None
        return {"id": "local", "name": "가족 공용", "role": "owner", "active": True}

    def authenticate(self, cookie):
        return not self.enabled or self._session(cookie) is not None

    def logout(self, cookie):
        digest = self._digest(cookie)
        if digest:
            self.store.delete("session", digest)
        if not self.enabled:
            self.store.set_meta('local_cache_binding', secrets.token_hex(16))

    def principal(self, cookie):
        session = self._session(cookie)
        if session and session.get("member_id"):
            member = self._member(session["member_id"])
            return self._safe(member) if member else None
        if self.enabled and not session:
            return None
        return {"id": "local", "name": "나" if not self._secret else "가족 공용",
                "email": "local@fountain.local", "role": "owner", "active": True}

    def session_info(self, cookie):
        # Resolve one login snapshot together. Acquiring the workspace writer
        # for every individual read lets SSE polls interleave between them.
        with self.store.lock:
            if self.store.transaction_depth:
                return self._session_info(cookie)
            with self.store.transaction():
                return self._session_info(cookie)

    def _session_info(self, cookie):
        session = self._session(cookie)
        member = self.principal(cookie)
        account = self.accounts_required or bool(session and session.get("member_id"))
        binding = None
        if session:
            binding = session.get('cache_binding', session['created_at'])
        elif member:
            with self.store.transaction():
                binding = self.store.meta('local_cache_binding')
                if not binding:
                    binding = secrets.token_hex(16)
                    self.store.set_meta('local_cache_binding', binding)
        return {"enabled": self.enabled, "required": self.enabled, "authenticated": member is not None,
                "mode": "accounts" if account else "family" if self._secret else "local",
                "identity": member["name"] if member else None, "member": member,
                "expires_at": session["expires_at"] if session else None,
                'workspace_id': self.store.meta('workspace_id'),
                'cache_binding': binding}


def main(argv=None):
    """Offline recovery requires filesystem access to the private database."""
    import argparse
    import getpass
    import sys
    from pathlib import Path
    from .core import Store
    parser = argparse.ArgumentParser(description="Reset an individual Fountain account password offline")
    parser.add_argument("action", choices=["reset"])
    parser.add_argument("member", help="Existing member id, such as local")
    parser.add_argument("--data", default=".data/fountain.db")
    args = parser.parse_args(argv)
    if not Path(args.data).is_file():
        print("Fountain account: database does not exist", file=sys.stderr)
        return 1
    store = None
    try:
        first = getpass.getpass("새 비밀번호: ")
        require(first == getpass.getpass("비밀번호 확인: "), "Passwords do not match")
        store = Store(args.data)
        member = Auth(store).set_password(args.member, first)
        print(f"Password reset for {member['email']}. Previous sessions were revoked.")
        return 0
    except (APIError, OSError, EOFError) as error:
        print(f"Fountain account: {error}", file=sys.stderr)
        return 1
    finally:
        if store is not None: store.close()


if __name__ == "__main__":
    raise SystemExit(main())
