import os, json

# --- CONFIG ---
REPO_NAME = "xtwon/twon-elo-system"
BRANCH = "main"
IMG_DIR = "images"
OUTPUT_FILE = "drive_links.json"

# GitHub raw base URL
BASE_URL = f"https://raw.githubusercontent.com/{REPO_NAME}/{BRANCH}/{IMG_DIR}"

def sanitize_key(name: str) -> str:
    """
    Build key that exactly matches how map_name + mapper appear in sheet.
    Only normalize spaces -> underscores. Keep all other characters intact.
    """
    return name.replace(" ", "_")

def build_links():
    if not os.path.exists(IMG_DIR):
        print(f"❌ Folder '{IMG_DIR}' not found. Make sure you run this script from your repo root.")
        return

    drive_links = {}
    files = os.listdir(IMG_DIR)
    print(f"📂 Found {len(files)} files in {IMG_DIR}")

    for fname in files:
        if fname.lower().endswith((".jpg", ".jpeg", ".png")):
            key = sanitize_key(os.path.splitext(fname)[0])
            url = f"{BASE_URL}/{fname}"
            drive_links[key] = url
            print(f"  ➕ Added: {key} → {url}")

    # Save JSON
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(drive_links, f, indent=2, ensure_ascii=False)

    print(f"✅ Updated {OUTPUT_FILE} with {len(drive_links)} entries.")

if __name__ == "__main__":
    build_links()
