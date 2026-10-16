import copy
import os
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from datetime import datetime, timezone

from fountain.core import APIError, AUDIT_ACTOR, Store
from fountain.scheduler import Scheduler, next_occurrence, validate_schedule


UTC = timezone.utc
START = "2026-01-31T09:30:00+09:00"


def dt(value):
    return datetime.fromisoformat(value)


def schedule(frequency="days", **fields):
    return {"frequency": frequency, "interval": 1, "timezone": "Asia/Seoul", "start_at": START, **fields}


class ScheduleTests(unittest.TestCase):
    def assert_invalid(self, value):
        with self.assertRaises(APIError) as error:
            validate_schedule(value)
        self.assertEqual(error.exception.status, 400)

    def test_validation_normalizes_aware_dates_and_defaults(self):
        source = schedule(end_at="2026-02-02T09:30:00+09:00")
        original = copy.deepcopy(source)
        result = validate_schedule(source)
        self.assertEqual(result["start_at"], "2026-01-31T00:30:00+00:00")
        self.assertEqual(result["end_at"], "2026-02-02T00:30:00+00:00")
        self.assertEqual(source, original)
        result = validate_schedule({"frequency": "minutes", "start_at": "2026-01-01T00:00:00Z"})
        self.assertEqual(result["interval"], 1)
        self.assertEqual(result["timezone"], "UTC")

    def test_validation_rejects_malformed_intervals_timezones_and_dates(self):
        invalid = [None, [], {}, schedule(interval=True), schedule(interval=0), schedule(interval=366),
                   schedule(interval=1.5), schedule(frequency=[]), schedule(frequency="fortnights"),
                   schedule(timezone="Missing/Zone"), schedule(timezone=[]), schedule(timezone="../UTC"),
                   schedule(start_at="2026-01-01"), schedule(start_at="not-a-date"), schedule(start_at=None),
                   schedule(start_at="1900-01-01T00:00:00Z"), schedule(start_at="9999-01-01T00:00:00Z"),
                   schedule(end_at="2025-01-01T00:00:00Z"), schedule(end_at=None), schedule(extra=True)]
        for value in invalid:
            with self.subTest(value=value):
                self.assert_invalid(value)

    def test_elapsed_intervals_are_strict_and_anchor_aligned_without_catchup_loops(self):
        value = schedule("minutes", interval=5)
        self.assertEqual(next_occurrence(value, "2026-01-30T00:00:00Z"), "2026-01-31T00:30:00+00:00")
        self.assertEqual(next_occurrence(value, "2026-01-31T00:30:00Z"), "2026-01-31T00:35:00+00:00")
        self.assertEqual(next_occurrence(value, "2040-01-31T00:34:59Z"), "2040-01-31T00:35:00+00:00")
        value = schedule("hours", interval=3)
        self.assertEqual(next_occurrence(value, "2026-01-31T05:00:00Z"), "2026-01-31T06:30:00+00:00")

    def test_calendar_months_preserve_original_day_after_short_month(self):
        value = schedule("months")
        february = next_occurrence(value, "2026-01-31T00:30:00Z")
        self.assertEqual(february, "2026-02-28T00:30:00+00:00")
        self.assertEqual(next_occurrence(value, february), "2026-03-31T00:30:00+00:00")
        self.assertEqual(next_occurrence(schedule("months", interval=2), february), "2026-03-31T00:30:00+00:00")

    def test_years_restore_leap_day_from_original_anchor(self):
        value = schedule("years", start_at="2024-02-29T09:30:00+09:00")
        self.assertEqual(next_occurrence(value, "2024-02-29T00:30:00Z"), "2025-02-28T00:30:00+00:00")
        self.assertEqual(next_occurrence(value, "2027-03-01T00:00:00Z"), "2028-02-29T00:30:00+00:00")

    def test_dst_gap_shifts_forward_without_permanent_wall_time_drift(self):
        value = schedule("days", timezone="America/New_York", start_at="2026-03-07T02:30:00-05:00")
        gap = next_occurrence(value, "2026-03-07T07:30:00Z")
        self.assertEqual(gap, "2026-03-08T07:30:00+00:00")  # 03:30 EDT
        self.assertEqual(next_occurrence(value, gap), "2026-03-09T06:30:00+00:00")  # 02:30 EDT
        hourly = dict(value, frequency="hours")
        self.assertEqual(next_occurrence(hourly, "2026-03-08T06:30:00Z"), gap)

    def test_dst_overlap_occurs_once_and_weeks_preserve_wall_time(self):
        value = schedule("days", timezone="America/New_York", start_at="2026-10-31T01:30:00-04:00")
        first = next_occurrence(value, "2026-10-31T05:30:00Z")
        self.assertEqual(first, "2026-11-01T05:30:00+00:00")
        self.assertEqual(next_occurrence(value, first), "2026-11-02T06:30:00+00:00")
        weekly = schedule("weeks", timezone="America/New_York", start_at="2026-03-01T09:00:00-05:00")
        self.assertEqual(next_occurrence(weekly, "2026-03-01T14:00:00Z"), "2026-03-08T13:00:00+00:00")

    def test_end_at_is_inclusive_and_exhausted_schedules_return_none(self):
        value = schedule("days", end_at="2026-02-01T09:30:00+09:00")
        self.assertEqual(next_occurrence(value, START), "2026-02-01T00:30:00+00:00")
        self.assertIsNone(next_occurrence(value, "2026-02-01T00:30:00Z"))
        self.assertIsNone(next_occurrence(value, "2030-01-01T00:00:00Z"))
        self.assertIsNone(next_occurrence(schedule("months", end_at=START), START))

    def test_next_occurrence_rejects_naive_after_and_date_overflow(self):
        with self.assertRaises(APIError):
            next_occurrence(schedule(), datetime(2026, 1, 1))
        with self.assertRaises(APIError):
            next_occurrence(schedule("years", start_at="9998-12-31T00:00:00Z"), "9998-12-31T00:00:00Z")


class SchedulerTests(unittest.TestCase):
    def setUp(self):
        self.store = Store(":memory:")
        self.store.put("member", {"id": "alice", "role": "member", "active": True})
        self.calls = []
        self.scheduler = Scheduler(self.store, self.callback)

    def tearDown(self):
        self.scheduler.stop()
        self.store.close()

    def callback(self, identity, body):
        self.calls.append((identity, body, AUDIT_ACTOR.get()))
        return self.store.put("row", {"id": "result", "actor": AUDIT_ACTOR.get()})

    def automation(self, **fields):
        return self.store.put("automation", {"id": "scheduled", "trigger": "scheduled", "enabled": True,
                                              "owner_id": "alice", "schedule": schedule("minutes"), **fields})

    def test_due_claim_action_and_advance_are_durable_and_restart_safe(self):
        self.automation(row_id="target")
        self.assertEqual(self.scheduler.tick("2026-01-31T00:29:59Z"), [])
        records = self.scheduler.tick("2026-01-31T00:30:00Z")
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["status"], "succeeded")
        self.assertEqual(records[0]["scheduled_at"], "2026-01-31T00:30:00+00:00")
        self.assertEqual(self.calls, [("scheduled", {"row_id": "target"}, "alice")])
        self.assertEqual(AUDIT_ACTOR.get(), "local")
        self.assertEqual(self.store.get("automation", "scheduled")["next_run_at"], "2026-01-31T00:31:00+00:00")
        restarted = Scheduler(self.store, self.callback)
        self.assertEqual(restarted.tick("2026-01-31T00:30:59Z"), [])
        self.assertEqual(len(self.store.list("automation_run")), 1)
        # Even an old next_run_at restored from a backup cannot repeat an existing claim.
        automation = self.store.get("automation", "scheduled")
        automation["next_run_at"] = "2026-01-31T09:30:00+09:00"
        self.store.put("automation", automation)
        self.assertEqual(restarted.tick("2026-01-31T00:30:59Z"), [])
        self.assertEqual(len(self.calls), 1)

    def test_two_schedulers_concurrently_claim_due_automation_only_once(self):
        self.automation()
        barrier = threading.Barrier(3)
        outcomes, errors = [], []
        def run(instance):
            try:
                barrier.wait()
                outcomes.extend(instance.tick("2026-01-31T00:30:00Z"))
            except Exception as error:
                errors.append(error)
        threads = [threading.Thread(target=run, args=(Scheduler(self.store, self.callback),)) for _ in range(2)]
        for thread in threads:
            thread.start()
        barrier.wait()
        for thread in threads:
            thread.join(2)
            self.assertFalse(thread.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(len(outcomes), 1)
        self.assertEqual(len(self.store.list("automation_run")), 1)

    def test_independent_store_connections_serialize_durable_claims(self):
        with tempfile.TemporaryDirectory() as directory:
            filename = os.path.join(directory, "shared.sqlite")
            stores = [Store(filename), Store(filename)]
            entered, release = threading.Event(), threading.Event()
            calls, outcomes, errors = [], [], []
            stores[0].put("member", {"id": "alice", "role": "member", "active": True})
            stores[0].put("automation", {"id": "a", "owner_id": "alice", "trigger": "scheduled", "schedule": schedule()})
            def callback(identity, body):
                calls.append(identity)
                entered.set()
                if not release.wait(2):
                    raise RuntimeError("Test did not release callback")
                return {}
            def run(store):
                try:
                    outcomes.extend(Scheduler(store, callback).tick(START))
                except Exception as error:
                    errors.append(error)
            threads = [threading.Thread(target=run, args=(store,)) for store in stores]
            try:
                threads[0].start()
                self.assertTrue(entered.wait(2))
                threads[1].start()
                # Give the second connection time to attempt a claim while the first writes.
                threading.Event().wait(0.05)
                release.set()
                for thread in threads:
                    thread.join(3)
                    self.assertFalse(thread.is_alive())
                self.assertEqual(errors, [])
                self.assertEqual(calls, ["a"])
                self.assertEqual(len(outcomes), 1)
                self.assertEqual(len(stores[1].list("automation_run")), 1)
            finally:
                release.set()
                for thread in threads:
                    if thread.ident is not None:
                        thread.join(3)
                for store in stores:
                    store.close()

    def test_callback_failure_rolls_back_every_action_but_keeps_failure_and_advances(self):
        self.automation()
        def broken(identity, body):
            self.store.put("row", {"id": "partial", "value": "must roll back"})
            self.store.audit("partial.action", {})
            raise APIError(403, "Current database permission denied")
        scheduler = Scheduler(self.store, broken)
        records = scheduler.tick("2026-01-31T00:30:00Z")
        self.assertEqual(records[0]["status"], "failed")
        self.assertIn("permission denied", records[0]["error"])
        self.assertIsNone(self.store.get("row", "partial"))
        self.assertEqual(self.store.list("audit"), [])
        self.assertEqual(scheduler.tick("2026-01-31T00:30:30Z"), [])
        self.assertEqual(self.store.get("automation", "scheduled")["next_run_at"], "2026-01-31T00:31:00+00:00")
        self.assertEqual(AUDIT_ACTOR.get(), "local")

    def test_unserializable_callback_result_also_rolls_back_actions(self):
        self.automation()
        def broken(identity, body):
            self.store.put("row", {"id": "partial"})
            return {"bad": object()}
        records = Scheduler(self.store, broken).tick(START)
        self.assertEqual(records[0]["status"], "failed")
        self.assertIsNone(self.store.get("row", "partial"))

    def test_missed_intervals_coalesce_once_and_advance_to_future_anchor(self):
        self.automation(schedule=schedule("minutes", interval=5))
        records = self.scheduler.tick("2026-04-10T12:33:00Z")
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["scheduled_at"], "2026-01-31T00:30:00+00:00")
        self.assertEqual(records[0]["next_run_at"], "2026-04-10T12:35:00+00:00")
        self.assertEqual(self.scheduler.tick("2026-04-10T12:34:00Z"), [])
        self.assertEqual(len(self.calls), 1)

    def test_inactive_deleted_and_invalid_authors_cannot_run(self):
        for member in ({"id": "alice", "role": "member", "active": False},
                       {"id": "alice", "role": "invalid", "active": True}, None):
            with self.subTest(member=member):
                if member is None:
                    self.store.delete("member", "alice")
                else:
                    self.store.put("member", member)
                self.automation()
                self.store.delete("automation_run", Scheduler._run_id("scheduled", "2026-01-31T00:30:00+00:00"))
                record = self.scheduler.tick(START)[0]
                self.assertEqual(record["status"], "failed")
                self.assertIn("author", record["error"])
        self.assertEqual(self.calls, [])

    def test_local_bootstrap_and_service_author_compatibility(self):
        self.automation(owner_id="local")
        self.assertEqual(self.scheduler.tick(START)[0]["status"], "succeeded")
        self.store.set_meta("auth_accounts_required", True)
        self.automation(id="required", owner_id="local")
        self.assertEqual(self.scheduler.tick(START)[0]["status"], "failed")
        self.automation(id="service", owner_id="scim")
        self.assertEqual(self.scheduler.tick(START)[0]["status"], "succeeded")
        self.store.put("member", {"id": "scim", "role": "owner", "active": False})
        self.automation(id="inactive-service", owner_id="scim")
        self.assertEqual(self.scheduler.tick(START)[0]["status"], "failed")

    def test_end_at_completes_without_repeated_runs(self):
        self.automation(schedule=schedule("days", end_at=START))
        record = self.scheduler.tick("2026-03-01T00:00:00Z")[0]
        self.assertIsNone(record["next_run_at"])
        automation = self.store.get("automation", "scheduled")
        self.assertFalse(automation["enabled"])
        self.assertEqual(automation["schedule_status"], "completed")
        self.assertEqual(self.scheduler.tick("2026-04-01T00:00:00Z"), [])
        self.assertEqual(len(self.calls), 1)

    def test_disabled_event_and_corrupt_schedule_do_not_loop(self):
        self.automation(enabled=False)
        self.automation(id="event", trigger="row.created")
        self.automation(id="corrupt", schedule={"frequency": "invalid"})
        records = self.scheduler.tick(START)
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["status"], "failed")
        self.assertFalse(self.store.get("automation", "corrupt")["enabled"])
        self.assertEqual(self.scheduler.tick(START), [])
        self.assertEqual(self.calls, [])

    def test_worker_store_failure_is_logged_and_exposed(self):
        with patch.object(self.scheduler, "tick", side_effect=RuntimeError("store unavailable")), \
                patch.object(self.scheduler._stop, "wait", side_effect=lambda _: self.scheduler._stop.set()), \
                self.assertLogs("fountain.scheduler", level="ERROR") as logs:
            self.scheduler._loop()
        self.assertEqual(self.scheduler.last_error, "store unavailable")
        self.assertIn("Scheduled automation worker failed", logs.output[0])

    def test_worker_start_stop_are_idempotent_and_store_remains_usable(self):
        observed = threading.Event()
        def callback(identity, body):
            observed.set()
            return {}
        self.automation(schedule=schedule(start_at="2020-01-01T00:00:00Z"))
        scheduler = Scheduler(self.store, callback)
        scheduler.start()
        thread = scheduler._thread
        scheduler.start()
        self.assertIs(scheduler._thread, thread)
        self.assertTrue(observed.wait(2))
        started = time.monotonic()
        scheduler.stop()
        scheduler.stop()
        self.assertLess(time.monotonic() - started, 1)
        self.assertFalse(thread.is_alive())
        self.assertIsNotNone(self.store.get("automation", "scheduled"))
        scheduler.start()
        self.assertTrue(scheduler._thread.is_alive())
        scheduler.stop()

    def test_persisted_run_survives_store_reopen(self):
        with tempfile.TemporaryDirectory() as directory:
            filename = os.path.join(directory, "scheduler.sqlite")
            store = Store(filename)
            store.put("member", {"id": "alice", "role": "member", "active": True})
            store.put("automation", {"id": "a", "owner_id": "alice", "trigger": "scheduled", "schedule": schedule()})
            calls = []
            Scheduler(store, lambda identity, body: calls.append(identity)).tick(START)
            store.close()
            store = Store(filename)
            try:
                self.assertEqual(Scheduler(store, lambda identity, body: calls.append(identity)).tick(START), [])
                self.assertEqual(calls, ["a"])
                self.assertEqual(len(store.list("automation_run")), 1)
            finally:
                store.close()


if __name__ == "__main__":
    unittest.main()
