import os, json, re

# --- CONFIG ---
REPO_NAME = "xtwon/twon-elo-system"
BRANCH = "main"
IMG_DIR = "images"
OUTPUT_FILE = "drive_links.json"

# GitHub raw base URL
BASE_URL = f"https://raw.githubusercontent.com/{REPO_NAME}/{BRANCH}/{IMG_DIR}"

def normalize_filename_for_key(name: str) -> str:
    # Remove extension
    name = os.path.splitext(name)[0]

    # Lowercase for consistency
    name = name.lower()

    # Replace spaces with underscores
    name = name.replace(" ", "_")

    # Special substitutions (safe surrogates)
    subs = {
        "*": "_star_",
        "&": "_and_",
        "!": "_bang_",
        "%": "_pct_",
        "+": "_plus_",
        "=": "_eq_",
        "?": "_qmark_",
        ":": "_colon_",
        ";": "_semi_",
        ",": "_comma_",
        ".": "_dot_",
        "'": "",   # drop apostrophes
        '"': "",   # drop quotes
        "[": "", "]": "",
        "(": "", ")": "",
        "<": "", ">": "",
        "~": "_tilde_",
    }
    for k, v in subs.items():
        name = name.replace(k, v)

    # Remove any leftover illegal characters
    name = re.sub(r"[^a-z0-9_\-]", "_", name)

    # Collapse multiple underscores
    name = re.sub(r"_+", "_", name)

    return name.strip("_")

def build_links():
    if not os.path.exists(IMG_DIR):
        print(f"❌ Folder '{IMG_DIR}' not found. Make sure you run this script from your repo root.")
        return

    drive_links = {}
    files = os.listdir(IMG_DIR)
    print(f"📂 Found {len(files)} files in {IMG_DIR}")

    for fname in files:
        if fname.lower().endswith((".jpg", ".jpeg", ".png")):
            key = normalize_filename_for_key(fname)
            url = f"{BASE_URL}/{fname}"
            drive_links[key] = url
            print(f"  ➕ Added: {key} → {url}")

    # Save JSON
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(drive_links, f, indent=2)

    print(f"✅ Updated {OUTPUT_FILE} with {len(drive_links)} entries.")

if __name__ == "__main__":
    build_links()
