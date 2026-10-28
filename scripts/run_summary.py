"""Markdown summary of a pipeline run (loader report + dbt results), for the GitHub Actions job summary.

    python scripts/run_summary.py >> "$GITHUB_STEP_SUMMARY"
"""
import json
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
load = ROOT / "reports" / "load_latest.json"
build = ROOT / "reports" / "dbt_build_results.json"

print("## Pipeline run\n")
if load.exists():
    r = json.loads(load.read_text())
    print(f"Loaded {r['start']} to {r['end']} for {r['cities']} cities.\n")
    print("| Table | Rows written | Months replaced | Empty cells | Seconds |\n|---|---|---|---|---|")
    for name, t in r["tables"].items():
        print(f"| {name} | {t['rows']:,} | {t['months_replaced']} | {sum(t['null_cells'].values()):,} | {t['seconds']} |")
    print()
else:
    print("Loader report missing: the load step did not finish.\n")

if build.exists():
    results = json.loads(build.read_text())["results"]
    counts = Counter(r["status"] for r in results)
    print("dbt build: " + ", ".join(f"{n} {status}" for status, n in sorted(counts.items())) + "\n")
    for r in results:
        if r["status"] in ("warn", "fail", "error"):
            print(f"- **{r['status']}** `{r['unique_id'].split('.')[2]}`: {r.get('failures') or r.get('message')}")
else:
    print("dbt build results missing: the build did not run.")
