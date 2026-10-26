// -----------------------------------------------------------------------------
// /data/rituals-state.json, the only writable place of the container. It
// keeps no secret (never the password, the e-mail nor the token): the time of
// the last read and of the last login (a restart never reads nor logs in
// sooner), a pause asked by Rituals, the marker of a refused login, the
// diffusers seen (hublot, hash) and the turns off still to confirm.
//
// `load()` -> the object, `null` when the file does not exist; it THROWS when
// the file exists but cannot be read or parsed: unreadable is not empty.
// `save()` writes through a temporary file and a rename, one write at a time.
// -----------------------------------------------------------------------------

import { readFile, rename, writeFile } from 'node:fs/promises';

export const STATE_FILE = '/data/rituals-state.json';

export function createFileStore(path = STATE_FILE) {
  let queue = Promise.resolve();
  return {
    async load() {
      let text;
      try {
        text = await readFile(path, 'utf8');
      } catch (err) {
        if (err?.code === 'ENOENT') return null;
        throw err;
      }
      const data = JSON.parse(text);
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('not an object');
      }
      return data;
    },
    save(data) {
      const text = JSON.stringify(data);
      const run = queue.then(async () => {
        const temporary = `${path}.tmp`;
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, path);
      });
      queue = run.catch(() => {});
      return run;
    },
  };
}

/** The same, in memory (tests): `data` is what a file would hold; `fail` makes the next calls throw. */
export function createMemoryStore(initial = null) {
  const store = {
    data: initial === null ? null : JSON.parse(JSON.stringify(initial)),
    saves: 0,
    failLoad: false,
    failSave: false,
    async load() {
      if (store.failLoad) throw new Error('unreadable');
      return store.data === null ? null : JSON.parse(JSON.stringify(store.data));
    },
    async save(data) {
      if (store.failSave) throw new Error('read-only');
      store.saves += 1;
      store.data = JSON.parse(JSON.stringify(data));
    },
  };
  return store;
}
