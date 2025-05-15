import typing
import logging
from pymongo.collection import Collection
from pymongo.errors import ServerSelectionTimeoutError

class GuildDataManager:
    def __init__(self, collection: Collection, module_name: str):
        self.db = collection
        self.module_name = module_name
        self.logger = logging.getLogger(f"bot.module.{module_name}.GuildDataManager")
        self.cache = {}

        try:
            self._load_all()
        except ServerSelectionTimeoutError:
            self.logger.error("Failed to connect to database.")

    def _load_all(self):
        """Loads all guild configs from the database."""
        result = self.db.find({})
        for doc in result:
            gid = doc.get("GUILD_ID")
            if gid:
                self.cache[gid] = doc
        self.logger.debug(f"Loaded {len(self.cache)} guilds into cache.")

    def get(self, guild_id: int, key: str):
        """Get a value for a specific guild and key."""
        if guild_id not in self.cache:
            self.cache[guild_id] = {}

        if key in self.cache[guild_id]:
            return self.cache[guild_id][key]

        result = self.db.find_one({"GUILD_ID": guild_id}, {key: 1, "_id": 0})
        if not result or key not in result:
            return None

        self.cache[guild_id][key] = result[key]
        return result[key]

    def set(self, guild_id: int, key: str, value: typing.Any):
        self.db.update_one({"GUILD_ID": guild_id}, {"$set": {key: value}}, upsert=True)
        self.cache.setdefault(guild_id, {})[key] = value

    def delete(self, guild_id: int, key: str):
        self.db.update_one({"GUILD_ID": guild_id}, {"$unset": {key: ""}}, upsert=True)
        self.cache.setdefault(guild_id, {}).pop(key, None)

    def replace_cache(self, guild_id: int, data: dict):
        """Overwrite the entire cache entry for a guild (used in update_cache)."""
        self.cache[guild_id] = data

    def get_cache(self, guild_id: int) -> dict:
        return self.cache.get(guild_id, {})

    # official methods

    def refresh_cache_from_db(self, guild_id: int):
        data = self.db.find_one({"GUILD_ID": guild_id})
        self.cache[guild_id] = data or {}
        
    def for_guild(self, guild_id: int) -> dict:
        if guild_id not in self.cache:
            self.refresh_cache_from_db(guild_id)
        return self.cache[guild_id]

