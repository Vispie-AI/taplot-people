import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("boss_sync", Path(__file__).with_name("sync-boss-resumes.py"))
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)

ORIGINAL = b"%PDF-1.7\nsynthetic original\n%%EOF"
SHA = hashlib.sha256(ORIGINAL).hexdigest()
RESULT = {"sourceRecordId": "rec-example", "sha256": SHA,
          "candidateId": "10000000-0000-4000-8000-000000000001",
          "fileId": "20000000-0000-4000-8000-000000000001", "deduplicated": False}


class IncrementalResumeSyncTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.config = {"state_path": str(Path(self.temp.name) / "state.sqlite3"),
                       "api_base_url": "https://harly.example.test", "gcp_project": "example-project",
                       "gcs_bucket": "example-private", "api_key_secret": "example-import-key",
                       "base_token": "example-base", "table_id": "example-table"}
        self.fields = {"Source": ["BOSS"], "Candidate Name": "Synthetic Candidate",
                       "Canonical Object Key": "resumes/example.pdf", "Document SHA256": SHA}
        for target, value in (("command", "synthetic-credential"),):
            mock = patch.object(sync, target, return_value=value)
            mock.start()
            self.addCleanup(mock.stop)
        output = patch("sys.stdout", new_callable=io.StringIO)
        output.start()
        self.addCleanup(output.stop)

    def run_sync(self, **kwargs):
        with patch.object(sync, "lark_records", return_value=iter([("rec-example", self.fields)])):
            return sync.sync(self.config, **kwargs)

    def checkpoint(self):
        with sqlite3.connect(self.config["state_path"]) as state:
            return state.execute("SELECT sha256,state,candidate_id,file_id FROM resume_sync").fetchone()

    def test_successful_record_is_incremental_and_verifies_gcs_checksum(self):
        with patch.object(sync, "request_bytes", return_value=ORIGINAL), \
             patch.object(sync, "import_original", return_value=RESULT) as post:
            self.assertEqual(self.run_sync()["synced"], 1)
            self.assertEqual(self.run_sync()["unchanged"], 1)
            post.assert_called_once()
        self.assertEqual(self.checkpoint(), (SHA, "synced", RESULT["candidateId"], RESULT["fileId"]))

    def test_failed_upload_is_retried_without_a_success_checkpoint(self):
        with patch.object(sync, "request_bytes", return_value=ORIGINAL), \
             patch.object(sync, "import_original", side_effect=RuntimeError("Synthetic failure")):
            self.assertEqual(self.run_sync()["failed"], 1)
        self.assertEqual(self.checkpoint()[1:], ("retry", None, None))
        with patch.object(sync, "request_bytes", return_value=ORIGINAL), \
             patch.object(sync, "import_original", return_value=RESULT):
            self.assertEqual(self.run_sync()["synced"], 1)

    def test_checksum_mismatch_never_reaches_harly(self):
        with patch.object(sync, "request_bytes", return_value=b"wrong bytes"), \
             patch.object(sync, "import_original") as post:
            self.assertEqual(self.run_sync()["failed"], 1)
            post.assert_not_called()
        self.assertEqual(self.checkpoint()[1], "retry")

    def test_missing_original_remains_retryable(self):
        self.fields["Canonical Object Key"] = ""
        with patch.object(sync, "request_bytes") as get:
            result = self.run_sync()
            self.assertEqual((result["missing_original"], result["failed"]), (1, 1))
            get.assert_not_called()

    def test_acceptance_submits_twice_and_checks_attachment_ids(self):
        with patch.object(sync, "request_bytes", return_value=ORIGINAL), \
             patch.object(sync, "import_original", return_value=RESULT) as post:
            self.assertEqual(self.run_sync(record_id="rec-example", verify_repeat=True)["synced"], 1)
            self.assertEqual(post.call_count, 2)

    def test_acceptance_rejects_two_different_attachment_ids(self):
        other = {**RESULT, "fileId": "20000000-0000-4000-8000-000000000002"}
        with patch.object(sync, "request_bytes", return_value=ORIGINAL), \
             patch.object(sync, "import_original", side_effect=[RESULT, other]):
            self.assertEqual(self.run_sync(record_id="rec-example", verify_repeat=True)["failed"], 1)
        self.assertEqual(self.checkpoint()[1], "retry")

    def test_changed_checksum_is_imported_again(self):
        with patch.object(sync, "request_bytes", return_value=ORIGINAL), \
             patch.object(sync, "import_original", return_value=RESULT):
            self.run_sync()
        revised = ORIGINAL + b"\nnew version"
        self.fields["Document SHA256"] = hashlib.sha256(revised).hexdigest()
        with patch.object(sync, "request_bytes", return_value=revised), \
             patch.object(sync, "import_original", return_value={**RESULT, "sha256": self.fields["Document SHA256"]}):
            self.assertEqual(self.run_sync()["synced"], 1)

    def test_refuses_checkpoint_reuse_with_a_different_destination(self):
        with patch.object(sync, "request_bytes", return_value=ORIGINAL), \
             patch.object(sync, "import_original", return_value=RESULT):
            self.run_sync()
        self.config["api_base_url"] = "https://other.example.test"
        with self.assertRaises(ValueError):
            self.run_sync()

    def test_pagination_reads_every_source_record(self):
        def page(record_id, more, offset):
            return json.dumps({"ok": True, "data": {
                "fields": sync.FIELDS, "query_context": {"record_scope": "filtered_records"}, "rev": 1,
                "record_id_list": [record_id], "data": [[self.fields.get(field) for field in sync.FIELDS]],
                "has_more": more, "next_offset": offset}})
        with patch.object(sync, "command", side_effect=[page("rec-a", True, 1), page("rec-b", False, 2)]):
            self.assertEqual([record_id for record_id, _ in sync.lark_records(self.config)], ["rec-a", "rec-b"])

    def test_live_base_updates_do_not_block_later_pages(self):
        def page(ids, more, offset, revision):
            return json.dumps({"ok": True, "data": {
                "fields": sync.FIELDS, "query_context": {"record_scope": "filtered_records"}, "rev": revision,
                "record_id_list": ids, "data": [[self.fields.get(field) for field in sync.FIELDS] for _ in ids],
                "has_more": more, "next_offset": offset}})
        with patch.object(sync, "command", side_effect=[
            page(["rec-a"], True, 1, 1), page(["rec-a", "rec-b"], False, 3, 2),
        ]):
            self.assertEqual([record_id for record_id, _ in sync.lark_records(self.config)], ["rec-a", "rec-b"])

    def test_only_reads_the_configured_private_bucket(self):
        self.assertEqual(sync.object_name("example-private", "gs://example-private/resumes/test.pdf"), "resumes/test.pdf")
        with self.assertRaises(ValueError):
            sync.object_name("example-private", "gs://other-bucket/resumes/test.pdf")

    def test_forwards_existing_contact_fields_for_candidate_resolution(self):
        fields = {**self.fields, "email": "candidate@example.test", "phone": "+1 555 010 1000"}
        _, body = sync.build_upload("rec-example", fields, ORIGINAL)
        self.assertIn(b'"email": "candidate@example.test"', body)
        self.assertIn(b'"phone": "+1 555 010 1000"', body)


if __name__ == "__main__":
    unittest.main()
