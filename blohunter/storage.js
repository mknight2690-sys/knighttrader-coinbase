const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

class BlohunterStorage extends EventEmitter {
  constructor(filePath) {
    super();
    this.filePath = filePath;
    this.local = {};
    this.session = {};
    this.loaded = false;
  }

  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        this.local = raw.local && typeof raw.local === 'object' ? raw.local : {};
        this.session = raw.session && typeof raw.session === 'object' ? raw.session : {};
      }
    } catch {
      this.local = {};
      this.session = {};
    }
    this.loaded = true;
  }

  persist() {
    if (!this.loaded) return;
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify({ local: this.local, session: this.session }, null, 0), 'utf8');
  }

  normalizeKeys(keys) {
    if (keys == null) return null;
    if (Array.isArray(keys)) return keys;
    if (typeof keys === 'string') return [keys];
    if (typeof keys === 'object') return Object.keys(keys);
    return null;
  }

  pick(area, keys) {
    const store = area === 'session' ? this.session : this.local;
    const keyList = this.normalizeKeys(keys);
    if (!keyList) return { ...store };
    const out = {};
    for (const key of keyList) {
      if (Object.prototype.hasOwnProperty.call(store, key)) out[key] = store[key];
    }
    if (typeof keys === 'object' && keys !== null && !Array.isArray(keys)) {
      for (const key of Object.keys(keys)) {
        if (!Object.prototype.hasOwnProperty.call(out, key)) out[key] = keys[key];
      }
    }
    return out;
  }

  setArea(area, items = {}) {
    const store = area === 'session' ? this.session : this.local;
    const changes = {};
    for (const [key, value] of Object.entries(items)) {
      const oldValue = store[key];
      store[key] = value;
      changes[key] = { oldValue, newValue: value };
    }
    this.persist();
    if (Object.keys(changes).length > 0) {
      this.emit('changed', changes, area);
    }
    return changes;
  }

  removeArea(area, keys) {
    const store = area === 'session' ? this.session : this.local;
    const keyList = this.normalizeKeys(keys) || [];
    const changes = {};
    for (const key of keyList) {
      if (Object.prototype.hasOwnProperty.call(store, key)) {
        changes[key] = { oldValue: store[key], newValue: undefined };
        delete store[key];
      }
    }
    this.persist();
    if (Object.keys(changes).length > 0) {
      this.emit('changed', changes, area);
    }
  }
}

module.exports = { BlohunterStorage };
