"""Durable, coalescing schedules for local database automation actions.

Minutes/hours measure elapsed UTC time. Days/weeks/months preserve the starting
local wall time; months always use the original day, clamped to the month's end.
DST gaps shift forward by the gap; overlaps use the first occurrence, once.
Only database work performed by the callback can share this transaction. External
side effects require a separately persisted outbox, not network calls here.
"""
from __future__ import annotations

import calendar
import hashlib
import logging
import threading
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .core import AUDIT_ACTOR, require

UTC = timezone.utc
LOGGER = logging.getLogger(__name__)
FREQUENCIES = {"minutes", "hours", "days", "weeks", "months", "years"}


def _datetime(value, name):
    if isinstance(value, str):
        require(len(value) <= 100, f"Invalid {name}")
        try:
            value = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            require(False, f"Invalid {name}")
    require(isinstance(value, datetime) and value.tzinfo is not None
            and value.utcoffset() is not None, f"{name} must include a timezone")
    try:
        value = value.astimezone(UTC)
    except (OverflowError, ValueError):
        require(False, f"Invalid {name}")
    require(1970 <= value.year <= 9998, f"{name} is outside supported date bounds")
    return value


def validate_schedule(schedule):
    require(isinstance(schedule, dict), "schedule must be an object")
    require(set(schedule) <= {"frequency", "interval", "timezone", "start_at", "end_at"}, "Unknown schedule field")
    frequency = schedule.get("frequency")
    require(isinstance(frequency, str) and frequency in FREQUENCIES, "Invalid schedule frequency")
    interval = schedule.get("interval", 1)
    require(type(interval) is int and 1 <= interval <= 365, "Schedule interval must be between 1 and 365")
    zone = schedule.get("timezone", "UTC")
    require(isinstance(zone, str) and 0 < len(zone) <= 100, "Invalid schedule timezone")
    try:
        ZoneInfo(zone)
    except (ZoneInfoNotFoundError, ValueError):
        require(False, "Unknown schedule timezone")
    require(isinstance(schedule.get("start_at"), str), "start_at must be an ISO datetime")
    anchor = _datetime(schedule["start_at"], "start_at")
    result = {"frequency": frequency, "interval": interval, "timezone": zone, "start_at": anchor.isoformat()}
    if "end_at" in schedule:
        require(isinstance(schedule["end_at"], str), "end_at must be an ISO datetime")
        end = _datetime(schedule["end_at"], "end_at")
        require(end >= anchor, "end_at cannot precede start_at")
        result["end_at"] = end.isoformat()
    return result


def _wall_time(naive, zone):
    # Round-tripping distinguishes genuine wall times from DST gap candidates.
    candidates = [naive.replace(tzinfo=zone, fold=fold).astimezone(UTC) for fold in (0, 1)]
    valid = [candidate for candidate in candidates
             if candidate.astimezone(zone).replace(tzinfo=None) == naive]
    if valid:
        return min(valid)
    forward = [candidate for candidate in candidates
               if candidate.astimezone(zone).replace(tzinfo=None) > naive]
    require(bool(forward), "Cannot resolve schedule local time")
    return min(forward)


def next_occurrence(schedule, after_datetime):
    """Return the next UTC ISO strictly after input, or None past inclusive end_at."""
    schedule = validate_schedule(schedule)
    after = _datetime(after_datetime, "after_datetime")
    anchor = _datetime(schedule["start_at"], "start_at")
    end = _datetime(schedule["end_at"], "end_at") if "end_at" in schedule else None
    if end is not None and after >= end:
        return None
    def finish(candidate):
        if end is not None and candidate > end:
            return None
        require(candidate.year <= 9998, "Schedule exceeds supported date bounds")
        return candidate.isoformat()
    if after < anchor:
        return anchor.isoformat()
    frequency, interval = schedule["frequency"], schedule["interval"]
    try:
        if frequency in {"minutes", "hours"}:
            step = timedelta(minutes=interval) if frequency == "minutes" else timedelta(hours=interval)
            return finish(anchor + ((after - anchor) // step + 1) * step)
        zone = ZoneInfo(schedule["timezone"])
        local = anchor.astimezone(zone).replace(tzinfo=None)
        after_local = after.astimezone(zone).replace(tzinfo=None)
        if frequency in {"months", "years"}:
            interval *= 12 if frequency == "years" else 1
            months = (after_local.year - local.year) * 12 + after_local.month - local.month
            index = max(0, months // interval)
            def occurrence(number):
                month_index = local.year * 12 + local.month - 1 + number * interval
                year, month = divmod(month_index, 12)
                month += 1
                day = min(local.day, calendar.monthrange(year, month)[1])
                return _wall_time(local.replace(year=year, month=month, day=day), zone)
        else:
            days = interval * (7 if frequency == "weeks" else 1)
            index = max(0, (after_local - local).days // days)
            def occurrence(number):
                return _wall_time(local + timedelta(days=number * days), zone)
        # The estimate is within one local period; no iteration through missed runs.
        while True:
            candidate = occurrence(index)
            if candidate > after and candidate >= anchor:
                return finish(candidate)
            index += 1
    except (OverflowError, ValueError):
        if end is not None:
            return None
        require(False, "Schedule exceeds supported date bounds")


class Scheduler:
    """Serialize claims, callback writes and schedule advancement in Store transactions."""
    def __init__(self, store, run_callback):
        self.store = store
        self.run_callback = run_callback
        self._lifecycle_lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = None
        self.last_error = None

    @staticmethod
    def _run_id(identity, scheduled_at):
        return hashlib.sha256((identity + "\n" + scheduled_at).encode()).hexdigest()

    def _author(self, automation):
        identity = automation.get("owner_id", "local")
        require(isinstance(identity, str) and bool(identity), "Automation author is invalid", 403)
        member = self.store.get("member", identity)
        bootstrap = identity == "local" and not self.store.meta("auth_accounts_required", False)
        service = identity == "scim"
        require((member is not None and member.get("active", True) is True
                 and member.get("role") in {"owner", "admin", "member", "guest"})
                or (member is None and (bootstrap or service)),
                "Automation author was deleted or deactivated", 403)
        return identity

    def tick(self, now=None):
        current = _datetime(now if now is not None else datetime.now(UTC), "now")
        runs = []
        # IDs are a snapshot; each item is re-read under the transaction lock.
        for candidate in self.store.list("automation"):
            with self.store.transaction():
                automation = self.store.get("automation", candidate["id"])
                if not automation or automation.get("trigger") != "scheduled" or not automation.get("enabled", True):
                    continue
                try:
                    schedule = validate_schedule(automation.get("schedule"))
                    due = _datetime(automation.get("next_run_at") or schedule["start_at"], "next_run_at")
                    if "end_at" in schedule and due > _datetime(schedule["end_at"], "end_at"):
                        automation.update(enabled=False, next_run_at=None, schedule_status="completed")
                        self.store.put("automation", automation)
                        continue
                    if due > current:
                        continue
                    following = next_occurrence(schedule, current)
                except Exception as error:
                    # Corrupt imported schedules cannot be advanced; disable once.
                    run = self.store.put("automation_run", {
                        "id": self._run_id(automation["id"], "invalid-schedule"),
                        "automation_id": automation["id"], "scheduled_at": None,
                        "started_at": current.isoformat(), "finished_at": current.isoformat(),
                        "status": "failed", "error": str(error)[:1000], "next_run_at": None})
                    automation.update(enabled=False, next_run_at=None, last_error=str(error)[:1000])
                    self.store.put("automation", automation)
                    runs.append(run)
                    continue
                scheduled_at = due.isoformat()
                run_id = self._run_id(automation["id"], scheduled_at)
                if self.store.get("automation_run", run_id):
                    automation["next_run_at"] = following
                    if following is None:
                        automation.update(enabled=False, schedule_status="completed")
                    self.store.put("automation", automation)
                    continue
                run = {"id": run_id, "automation_id": automation["id"], "scheduled_at": scheduled_at,
                       "started_at": current.isoformat(), "status": "running", "next_run_at": following}
                self.store.put("automation_run", run)
                try:
                    # Nested rollback retains the claim but undoes every callback write.
                    with self.store.transaction():
                        author = self._author(automation)
                        token = AUDIT_ACTOR.set(author)
                        try:
                            body = {"row_id": automation["row_id"]} if automation.get("row_id") else {}
                            result = self.run_callback(automation["id"], body)
                        finally:
                            AUDIT_ACTOR.reset(token)
                        run.update(status="succeeded", result=result)
                        # Serialization failures must roll back callback writes too.
                        self.store.put("automation_run", run)
                except Exception as error:
                    run.pop("result", None)
                    run.update(status="failed", error=str(error)[:1000])
                run["finished_at"] = current.isoformat()
                run = self.store.put("automation_run", run)
                latest = self.store.get("automation", automation["id"])
                if latest:
                    latest.update(next_run_at=following, last_run_at=current.isoformat(),
                                  last_run_status=run["status"], last_error=run.get("error"))
                    if following is None:
                        latest.update(enabled=False, schedule_status="completed")
                    self.store.put("automation", latest)
                runs.append(run)
        return runs

    def _loop(self):
        while not self._stop.is_set():
            try:
                self.tick()
                self.last_error = None
            except Exception as error:
                # A transient store error must not kill future schedule checks.
                self.last_error = str(error)[:1000]
                LOGGER.exception("Scheduled automation worker failed")
            self._stop.wait(1)

    def start(self):
        with self._lifecycle_lock:
            if self._thread is not None and self._thread.is_alive():
                return
            self._stop.clear()
            self._thread = threading.Thread(target=self._loop, name="fountain-scheduler", daemon=True)
            self._thread.start()

    def stop(self):
        with self._lifecycle_lock:
            self._stop.set()
            thread = self._thread
        # Never hold a lifecycle/store lock while waiting on the worker.
        if thread is not None and thread is not threading.current_thread():
            thread.join()
