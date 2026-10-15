"""Optional shared-family access gate; identity is shared, with no per-person ACL."""
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
        return bool(self._secret)

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
        require(self.enabled, "Login is unnecessary in local mode", 409)
        self._limit(client)
        require(isinstance(body, dict) and isinstance(body.get("token"), str)
                and len(body["token"]) <= 4096, "A valid access token is required", 400)
        require(hmac.compare_digest(body["token"].encode(), self._secret.encode()),
                "Access token is incorrect", 401)
        token = secrets.token_urlsafe(32)
        digest = hashlib.sha256(token.encode()).hexdigest()
        expires = datetime.now(timezone.utc) + timedelta(seconds=SESSION_SECONDS)
        with self.store.transaction():
            # Expired sessions are removed during successful logins.
            current = datetime.now(timezone.utc).isoformat()
            for session in self.store.list("session"):
                if session.get("expires_at", "") <= current:
                    self.store.delete("session", session["id"])
            self.store.put("session", {"id": digest, "expires_at": expires.isoformat(),
                                       "credential_tag": self._tag(digest)})
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
        digest = self._digest(cookie)
        if not digest:
            return None
        session = self.store.get("session", digest)
        if not session:
            return None
        try:
            valid = (datetime.fromisoformat(session["expires_at"]) > datetime.now(timezone.utc)
                     and hmac.compare_digest(session.get("credential_tag", ""), self._tag(digest)))
        except (ValueError, TypeError, KeyError):
            valid = False
        if not valid:
            self.store.delete("session", digest)
            return None
        return session

    def authenticate(self, cookie):
        return not self.enabled or self._session(cookie) is not None

    def logout(self, cookie):
        digest = self._digest(cookie)
        if digest:
            self.store.delete("session", digest)

    def session_info(self, cookie):
        session = self._session(cookie) if self.enabled else None
        authenticated = not self.enabled or session is not None
        return {"enabled": self.enabled, "authenticated": authenticated,
                "mode": "family" if self.enabled else "local",
                "identity": ("가족 공용" if self.enabled else "나") if authenticated else None,
                "expires_at": session["expires_at"] if session else None}
