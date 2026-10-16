"""Subitems and task scheduling with explicit, deterministic policies.

Dependency shifts keep calendar-day duration. Weekend avoidance translates a
whole range forward to the first placement whose two endpoints are weekdays.
This may increase gaps; intermediate weekend days remain part of the duration.
Aware date-times retain supplied endpoint offsets; optional IANA zone metadata
is validated and preserved without reinterpreting offsets across DST changes.
"""
from __future__ import annotations

import copy
import heapq
from collections import deque
from datetime import date, datetime, timedelta

from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .core import APIError, require, text, uid

MAX_GRAPH = 10000
DEFAULT_SETTINGS = {"subitems": False, "dependencies": False, "date_property": "due",
                    "shift": "none", "skip_weekends": False}


def _parse_atom(value):
    require(isinstance(value, str), "Date must be an ISO string")
    try:
        if len(value) == 10:
            parsed = date.fromisoformat(value)
            require(parsed.isoformat() == value, "Use YYYY-MM-DD dates")
            return parsed
        require("T" in value and len(value) <= 40, "Use ISO dates or date-times")
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        require(parsed.utcoffset() is not None, "Date-times require an explicit UTC offset")
        return parsed
    except ValueError:
        raise APIError(400, "Invalid calendar date or date-time")


def validate_date_value(value):
    if value is None or value == "": return value
    if isinstance(value, str): return _parse_atom(value).isoformat()
    require(isinstance(value, dict) and set(value) <= {"start", "end", "time_zone"} and "start" in value,
            "Dates must be ISO strings or {start, end, time_zone} objects")
    start = _parse_atom(value["start"])
    result = {"start": start.isoformat()}
    if value.get("end") not in (None, ""):
        end = _parse_atom(value["end"])
        require(type(start) is type(end), "Date range endpoints must have the same precision")
        require(end >= start, "Date range ends before it starts")
        result["end"] = end.isoformat()
    elif "end" in value: result["end"] = value["end"]
    if "time_zone" in value:
        zone = value["time_zone"]
        if zone is not None:
            require(isinstance(zone, str) and 0 < len(zone) <= 100, "Invalid IANA time zone")
            try: ZoneInfo(zone)
            except (ZoneInfoNotFoundError, ValueError): raise APIError(400, "Unknown IANA time zone")
        result["time_zone"] = zone
    return result


def parse_date_value(value):
    value = validate_date_value(value)
    if value is None or value == "": return None
    if isinstance(value, str):
        point = _parse_atom(value)
        return point, point
    start = _parse_atom(value["start"])
    return start, _parse_atom(value["end"]) if value.get("end") else start


def validate_settings(body, database):
    require(isinstance(body, dict), "Invalid task settings")
    if "task_settings" in body: body = body["task_settings"]
    require(isinstance(body, dict) and set(body) <= set(DEFAULT_SETTINGS), "Invalid task settings")
    previous = database.get("task_settings", {})
    require(isinstance(previous, dict) and set(previous) <= set(DEFAULT_SETTINGS), "Invalid stored task settings")
    result = {**DEFAULT_SETTINGS, **previous, **body}
    for key in ("subitems", "dependencies", "skip_weekends"):
        require(type(result[key]) is bool, f"{key} must be boolean")
    require(isinstance(result["shift"], str) and result["shift"] in {"none", "overlap", "maintain"}, "Invalid dependency shift mode")
    text(result["date_property"], "task date property", 160, False)
    if result["dependencies"] and result["shift"] != "none":
        require(any(p["id"] == result["date_property"] and p["type"] == "date" for p in database.get("properties", [])),
                "Choose a date property for automatic task shifting")
    return result


class TaskGraph:
    def __init__(self, store):
        self.store = store

    validate_settings = staticmethod(validate_settings)

    def _rows(self, database_id, rows=None):
        records = self.store.list("row") if rows is None else list(rows.values()) if isinstance(rows, dict) else rows
        require(isinstance(records, list) and all(isinstance(row, dict) and isinstance(row.get("id"), str) for row in records),
                "Task rows must be a list or mapping of row objects")
        records = [row for row in records if row.get("database_id") == database_id]
        require(len(records) <= MAX_GRAPH, "Task graph exceeds 10000 rows")
        return {row["id"]: copy.deepcopy(row) for row in records}

    @staticmethod
    def _order(rows, field):
        require(len(rows) <= MAX_GRAPH, "Task graph exceeds 10000 rows")
        children, degrees, edges = {key: [] for key in rows}, {}, 0
        for key, row in rows.items():
            links = ([row.get(field)] if row.get(field) else []) if field == "parent_row_id" else row.get(field, [])
            require(isinstance(links, list) and all(isinstance(link, str) for link in links), "Invalid task links")
            require(len(set(links)) == len(links), "Duplicate task dependency")
            degrees[key] = len(links)
            edges += len(links)
            require(edges <= MAX_GRAPH, "Task graph exceeds 10000 links")
            for link in links:
                require(link in rows and link != key, "Task links must reference another row in the same database")
                children[link].append(key)
        ready, ordered = [key for key, degree in degrees.items() if degree == 0], []
        heapq.heapify(ready)
        while ready:
            key = heapq.heappop(ready)
            ordered.append(key)
            for child in children[key]:
                degrees[child] -= 1
                if degrees[child] == 0: heapq.heappush(ready, child)
        require(len(ordered) == len(rows), "Task links cannot contain cycles")
        return ordered, children

    def prepare_row(self, database, row_id, body, existing=None, rows=None):
        require(isinstance(body, dict), "Task changes must be an object")
        text(row_id, "row id", 160, False)
        existing = existing or {}
        result = {"parent_row_id": body.get("parent_row_id", existing.get("parent_row_id")),
                  "depends_on": copy.deepcopy(body.get("depends_on", existing.get("depends_on", [])))}
        parent, dependencies = result["parent_row_id"], result["depends_on"]
        require(parent is None or isinstance(parent, str) and 0 < len(parent) <= 160, "Invalid parent row")
        require(isinstance(dependencies, list) and len(dependencies) <= MAX_GRAPH
                and all(isinstance(item, str) and 0 < len(item) <= 160 for item in dependencies), "Invalid task dependencies")
        settings = validate_settings({}, database)
        for field, toggle in (("parent_row_id", "subitems"), ("depends_on", "dependencies")):
            require(settings[toggle] or not result[field] or result[field] == existing.get(field),
                    f"Enable {toggle} before adding task links")
        records = self._rows(database["id"], rows)
        records[row_id] = {**existing, **result, "id": row_id, "database_id": database["id"]}
        require(len(records) <= MAX_GRAPH, "Task graph exceeds 10000 rows")
        self._order(records, "parent_row_id")
        self._order(records, "depends_on")
        return result

    def descendants(self, database_id, row_id):
        records = self._rows(database_id)
        require(row_id in records, "Task not found", 404)
        _, children = self._order(records, "parent_row_id")
        pending, result = deque([row_id]), []
        while pending:
            key = pending.popleft()
            result.append(records[key])
            pending.extend(sorted(children[key]))
        return result

    def duplicate_plan(self, database_id, row_id, owner_id, can_read=None):
        """Copy a readable subtree privately, remapping its internal graph."""
        text(owner_id, "copy owner", 160, False)
        database = self.store.get("database", database_id)
        require(database is not None, "Database not found", 404)
        subtree = self.descendants(database_id, row_id)
        require(can_read is None or all(can_read(copy.deepcopy(row)) for row in subtree),
                "The complete task subtree must be readable before duplication", 403)
        identities = {row["id"]: uid() for row in subtree}

        def reference(identity):
            if identity in identities: return identities[identity]
            target = self.store.get("row", identity) if isinstance(identity, str) else None
            return identity if target and (can_read is None or can_read(copy.deepcopy(target))) else None

        relations = [prop["id"] for prop in database.get("properties", []) if prop["type"] == "relation"]
        copies = []
        for row in subtree:
            duplicated = copy.deepcopy(row)
            for field in ("id", "created_at", "updated_at", "computed_errors", "access_level"):
                duplicated.pop(field, None)
            duplicated.update(id=identities[row["id"]], owner_id=owner_id,
                parent_row_id=reference(row.get("parent_row_id")),
                depends_on=[target for identity in row.get("depends_on", []) if (target := reference(identity))],
                permissions={"default": "private", "inherit": False, "members": {owner_id: "full"}, "groups": {}})
            for key in relations:
                values = duplicated.get("properties", {}).get(key)
                if isinstance(values, list):
                    duplicated["properties"][key] = [target for identity in values if (target := reference(identity))]
            copies.append(duplicated)
        combined = self._rows(database_id)
        combined.update({row["id"]: row for row in copies})
        self._order(combined, "parent_row_id")
        self._order(combined, "depends_on")
        return copies

    @staticmethod
    def _shift_value(value, start, end):
        if isinstance(value, str): return start.isoformat()
        shifted = {"start": start.isoformat()}
        if value.get("end"): shifted["end"] = end.isoformat()
        elif "end" in value: shifted["end"] = value["end"]
        if "time_zone" in value: shifted["time_zone"] = value["time_zone"]
        return shifted

    def plan_shift(self, database, old_row, candidate, can_edit=None):
        settings = validate_settings({}, database)
        if not settings["dependencies"] or settings["shift"] == "none": return []
        root = old_row["id"]
        require(candidate.get("id", root) == root and old_row["database_id"] == database["id"]
                and candidate.get("database_id", database["id"]) == database["id"], "Invalid scheduling root")
        original = self._rows(database["id"])
        original[root] = copy.deepcopy(old_row)
        current = copy.deepcopy(original)
        current[root] = {**copy.deepcopy(old_row), **copy.deepcopy(candidate), "properties": {
            **copy.deepcopy(old_row.get("properties", {})), **copy.deepcopy(candidate.get("properties", {}))}}
        order, children = self._order(current, "depends_on")
        key = settings["date_property"]
        dates = lambda row: parse_date_value(row.get("properties", {}).get(key))
        before, after = dates(old_row), dates(current[root])
        if after is None or before == after: return []
        reachable, pending = set(), deque(children[root])
        while pending:
            identity = pending.popleft()
            if identity in reachable: continue
            reachable.add(identity)
            pending.extend(children[identity])
        changed, result = {root}, []
        for identity in order:
            row = current[identity]
            links = row.get("depends_on", [])
            if identity not in reachable or not any(link in changed for link in links): continue
            if can_edit is not None and not can_edit(copy.deepcopy(row)): continue
            value = row.get("properties", {}).get(key)
            span = parse_date_value(value)
            if span is None: continue
            start, end = span
            constraints = []
            try:
                for link in links:
                    predecessor, previous = dates(current[link]), dates(original[link])
                    if predecessor is None: continue
                    require(type(predecessor[1]) is type(start) and (previous is None or type(previous[1]) is type(start)),
                            "Automatic shifting cannot mix date-only and date-time tasks")
                    minimum = timedelta(0) if isinstance(start, datetime) else timedelta(days=1)
                    gap = max(minimum, start - previous[1]) if previous and settings["shift"] == "maintain" else minimum
                    constraints.append(predecessor[1] + gap)
                if not constraints: continue
                desired = max(constraints)
                if isinstance(start, datetime): desired = desired.astimezone(start.tzinfo)
                if settings["shift"] == "overlap": desired = max(start, desired)
                if desired == start: continue
                duration = end - start
                shifted_end = desired + duration
                if isinstance(end, datetime): shifted_end = shifted_end.astimezone(end.tzinfo)
                if settings["skip_weekends"]:
                    while desired.weekday() >= 5 or shifted_end.weekday() >= 5:
                        desired += timedelta(days=1)
                        shifted_end += timedelta(days=1)
            except OverflowError:
                raise APIError(400, "Task date shift exceeds the calendar range")
            if desired == start: continue
            row["properties"][key] = self._shift_value(value, desired, shifted_end)
            changed.add(identity)
            result.append(copy.deepcopy(row))
        return result
