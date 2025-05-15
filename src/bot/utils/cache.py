import time

class Cache:
    def __init__(self, ttl=None):
        self.cache = {}  # key: (data, timestamp, ttl)
        self.ttl = ttl   # default TTL (global)

    def get(self, key, fallback=None):
        if key in self.cache:
            data, timestamp, ttl = self.cache[key]
            ttl = ttl if ttl is not None else self.ttl
            if ttl is None or time.time() - timestamp < ttl:
                return data
            else:
                del self.cache[key]
        return fallback

    def set(self, key, data, ttl=None):
        self.cache[key] = (data, time.time(), ttl)

    def delete(self, key):
        if key in self.cache:
            del self.cache[key]
            
    def find(self, startswith=None, endswith=None, contains=None):
        """
        Returns a dictionary with entries whose keys corresponds with the search criteria
        Criterias:
            - startswith: string whose key needs to start with
            - endswith: string whose key needs to end with
            - contains: string whose key needs to contain in
        Only returns valid entries (within TTL).
        """
        result = {}
        for k in list(self.cache.keys()):  # list() evita erro de modificação durante iteração
            data = self.get(k)  # verifica se ainda está válido (TTL)
            if data is None:
                continue
            if startswith and not k.startswith(startswith):
                continue
            if endswith and not k.endswith(endswith):
                continue
            if contains and contains not in k:
                continue
            result[k] = data
        return result

        

    def clear(self):
        self.cache = {}
