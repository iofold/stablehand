"""Push a Bugfarm dataset folder to the Hugging Face Hub.

    uv run --with 'huggingface_hub>=0.34' python hf_push.py --folder DIR --repo ORG/NAME \
        --visibility private --dataset-sha SHA [--dry-run]

- The repo is a dataset repo. It is created private unless --visibility public is passed, and
  this script refuses to upload a private-intended dataset into a repo that is already public.
- The token comes from HF_TOKEN or huggingface_hub's own login (~/.cache/huggingface/token); it
  is never printed or written anywhere.
- --dry-run makes no network call at all: it prints what would be uploaded.
- The dataset sha must match provenance/manifest.json, so what was approved is what is uploaded.

Prints one JSON object on stdout.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

IGNORE = [".publish/**", ".publish"]


def manifest_ok(folder: Path, expected_sha: str) -> tuple[bool, str]:
    manifest = json.loads((folder / "provenance" / "manifest.json").read_text())
    if manifest.get("dataset_sha256") != expected_sha:
        return False, f"manifest names dataset {manifest.get('dataset_sha256')}, not the approved {expected_sha}"
    lines = []
    for entry in manifest["files"]:
        path = folder / entry["path"]
        if not path.is_file():
            return False, f"{entry['path']} is in the manifest but missing"
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest != entry["sha256"]:
            return False, f"{entry['path']} changed after the manifest was written"
        lines.append(f"{entry['sha256']}  {entry['path']}")
    if hashlib.sha256("\n".join(lines).encode()).hexdigest() != expected_sha:
        return False, "the manifest's files do not hash to the approved dataset sha"
    return True, "ok"


def plan(folder: Path) -> dict:
    files = [p for p in sorted(folder.rglob("*")) if p.is_file() and ".publish" not in p.relative_to(folder).parts]
    top: dict[str, int] = {}
    for p in files:
        head = p.relative_to(folder).parts[0]
        top[head] = top.get(head, 0) + 1
    return {"files": len(files), "bytes": sum(p.stat().st_size for p in files), "top_level": top}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--folder", required=True)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--visibility", choices=["private", "public"], default="private")
    parser.add_argument("--dataset-sha", required=True)
    parser.add_argument("--commit-message", default="Publish Bugfarm dataset")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    folder = Path(args.folder).resolve()
    ok, why = manifest_ok(folder, args.dataset_sha)
    if not ok:
        print(json.dumps({"ok": False, "error": why}))
        return 3
    summary = {"repo": args.repo, "repo_type": "dataset", "visibility": args.visibility, "dataset_sha256": args.dataset_sha, **plan(folder)}
    if args.dry_run:
        print(json.dumps({"ok": True, "dry_run": True, "would": ["create_repo (if missing)", "upload_folder"], **summary}))
        return 0

    from huggingface_hub import HfApi
    from huggingface_hub.utils import RepositoryNotFoundError

    api = HfApi(token=os.environ.get("HF_TOKEN") or None)
    private = args.visibility != "public"
    try:
        info = api.repo_info(args.repo, repo_type="dataset")
        if private and not getattr(info, "private", True):
            print(json.dumps({"ok": False, "error": f"{args.repo} already exists and is public; refusing to upload a dataset meant to be private"}))
            return 4
        created = False
    except RepositoryNotFoundError:
        api.create_repo(args.repo, repo_type="dataset", private=private, exist_ok=False)
        created = True
    commit = api.upload_folder(
        folder_path=str(folder),
        repo_id=args.repo,
        repo_type="dataset",
        commit_message=args.commit_message,
        commit_description=f"dataset sha256 {args.dataset_sha}",
        ignore_patterns=IGNORE,
    )
    print(json.dumps({"ok": True, "dry_run": False, "created_repo": created, "commit_url": getattr(commit, "commit_url", str(commit)), **summary}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
