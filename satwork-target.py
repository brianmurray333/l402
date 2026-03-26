"""
After paying the 5000 sat invoice, run this script to:
1. Confirm the deposit
2. Register the Million Sat Homepage spatial lookup optimization target
"""
import json
import urllib.request

AGENT_KEY = "sk-5e5fb9e41745ffc3f285690eade80beaa392c1027db353b274e9e3fbf48c3654"
PAYMENT_HASH = "55b126921030dff05f2c8f8ff03d557bcb3d1d344473c35963f3a854aa96d60c"
BASE = "https://satwork.ai/api"

EVAL_SCRIPT = r'''
import json, time, random
from pathlib import Path

random.seed(42)

GRID = 1000
NUM_BLOCKS = 500
NUM_QUERIES = 50000

blocks = []
for i in range(NUM_BLOCKS):
    w = random.randint(2, 40)
    h = random.randint(2, 40)
    x = random.randint(0, GRID - w)
    y = random.randint(0, GRID - h)
    blocks.append({"id": i, "x": x, "y": y, "width": w, "height": h,
                   "color": "#ff9900", "title": f"Block {i}"})

def naive_lookup(blocks, px, py):
    for i in range(len(blocks) - 1, -1, -1):
        b = blocks[i]
        if px >= b["x"] and px < b["x"] + b["width"] and py >= b["y"] and py < b["y"] + b["height"]:
            return b
    return None

queries = [(random.randint(0, GRID - 1), random.randint(0, GRID - 1)) for _ in range(NUM_QUERIES)]
ref_ids = [(naive_lookup(blocks, qx, qy) or {}).get("id", -1) for qx, qy in queries]

import importlib.util
spec = importlib.util.spec_from_file_location("spatial", str(Path(__file__).parent / "spatial_index.py"))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

try:
    index = mod.build_index(blocks, GRID)
except Exception:
    print("lookup_score: 0.0000")
    raise SystemExit

correct = 0
for i, (qx, qy) in enumerate(queries):
    try:
        result = mod.query(index, qx, qy)
        rid = result["id"] if result else -1
        if rid == ref_ids[i]:
            correct += 1
    except Exception:
        pass

correctness = correct / NUM_QUERIES

if correctness < 0.95:
    print(f"lookup_score: {correctness * 0.1:.4f}")
    raise SystemExit

for qx, qy in queries[:1000]:
    mod.query(index, qx, qy)

t0 = time.perf_counter()
for qx, qy in queries:
    mod.query(index, qx, qy)
elapsed = time.perf_counter() - t0

qps = NUM_QUERIES / max(elapsed, 0.001)
score = correctness * min(qps / 1_000_000, 1.0)
print(f"lookup_score: {score:.4f}")
'''

MUTABLE_CODE = '''\
"""
Spatial index for pixel block lookup on a 1000x1000 grid.

blocks: list of dicts with keys: id, x, y, width, height, color, title
When multiple blocks overlap at a query point, return the one with the
HIGHEST index (last in the list wins -- matching the rendering order).

Optimize build_index and query for maximum throughput on 50k random queries
across 500 blocks. Correctness must stay above 95%.
"""

def build_index(blocks, grid_size):
    return {"blocks": blocks, "grid_size": grid_size}

def query(index, px, py):
    blocks = index["blocks"]
    for i in range(len(blocks) - 1, -1, -1):
        b = blocks[i]
        if px >= b["x"] and px < b["x"] + b["width"] and py >= b["y"] and py < b["y"] + b["height"]:
            return b
    return None
'''

DESCRIPTION = (
    "Optimize the spatial lookup function for the Million Sat Homepage "
    "(l402apps.com/million) -- a 1000x1000 pixel grid with ~500 rectangular blocks. "
    "The query function is called on every mouse hover to find which block contains "
    "the cursor. Currently uses O(n) linear scan. Optimize with spatial indexing "
    "(grid cells, quadtree, R-tree, etc). When blocks overlap, the highest-index "
    "block wins (last painted). Score = correctness * normalized_throughput. "
    "Must maintain >95% correctness."
)


def post_json(url, body):
    data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    try:
        resp = urllib.request.urlopen(req)
        return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return {"error": f"HTTP {e.code}", "detail": e.read().decode()}


if __name__ == "__main__":
    # Step 1: Confirm deposit
    print("Confirming deposit...")
    result = post_json(f"{BASE}/agent/{AGENT_KEY}/deposit", {
        "amount_sats": 5000,
        "payment_hash": PAYMENT_HASH,
    })
    print(json.dumps(result, indent=2))

    if "error" in result and "already" not in result.get("detail", "").lower():
        print("\nDeposit not confirmed yet. Pay the invoice first, then re-run.")
        raise SystemExit(1)

    # Step 2: Check balance
    bal_resp = urllib.request.urlopen(f"{BASE}/agent/{AGENT_KEY}/balance")
    bal = json.loads(bal_resp.read())
    print(f"\nBalance: {bal['available_sats']} sats")

    if bal["available_sats"] < 5000:
        print("Insufficient balance to create target.")
        raise SystemExit(1)

    # Step 3: Register target
    print("\nRegistering optimization target...")
    target = post_json(f"{BASE}/targets", {
        "name": "Million Sat Homepage — Spatial Pixel Block Lookup",
        "privacy_tier": "described",
        "metric_name": "lookup_score",
        "metric_direction": "maximize",
        "description": DESCRIPTION,
        "budget_sats": 5000,
        "cost_per_proposal": 5,
        "reward_sats": 200,
        "eval_script": EVAL_SCRIPT,
        "mutable_files": {"spatial_index.py": MUTABLE_CODE},
        "agent_key": AGENT_KEY,
    })
    print(json.dumps(target, indent=2))

    if target.get("target_id"):
        print(f"\nTarget created: {target['target_id']}")
        print(f"Baseline score: {target.get('baseline_score', 'N/A')}")
        print("AI agents will now compete to optimize your spatial lookup!")
    else:
        print("\nTarget creation failed. Check the error above.")
