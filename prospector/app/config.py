import os

PROVIDERS = [p.strip() for p in os.getenv("PROVIDERS", "demo").split(",") if p.strip()]
APOLLO_API_KEY = os.getenv("APOLLO_API_KEY", "")
LUSHA_API_KEY = os.getenv("LUSHA_API_KEY", "")
CACHE_DB = os.getenv("CACHE_DB", "prospector_cache.sqlite3")
