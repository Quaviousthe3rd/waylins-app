// Minimal in-memory Firestore standing in for firebase-admin/firestore in
// unit tests (aliased in vitest.config.ts). Implements exactly the surface
// settleCharge uses: doc get/create/set/delete, collection doc()/where().get(),
// runTransaction with getAll/get/create/set/delete, and tx.create throwing
// code 6 (ALREADY_EXISTS) on an existing path — the idempotency mechanism
// under test.

type DocData = Record<string, any>;

const store = new Map<string, DocData>();
let idCounter = 0;

export const __reset = () => {
  store.clear();
  idCounter = 0;
};
export const __store = store;

class DocRef {
  constructor(public path: string) {}
  get id() {
    return this.path.split('/').pop()!;
  }
  async get() {
    return makeSnap(this);
  }
  async create(data: DocData) {
    createSync(this, data);
  }
  async set(data: DocData, opts?: { merge?: boolean }) {
    setSync(this, data, opts);
  }
  async update(data: DocData) {
    store.set(this.path, { ...(store.get(this.path) ?? {}), ...data });
  }
  async delete() {
    store.delete(this.path);
  }
}

const makeSnap = (ref: DocRef) => ({
  exists: store.has(ref.path),
  data: () => (store.has(ref.path) ? { ...store.get(ref.path)! } : undefined),
  ref,
  id: ref.id,
});

const alreadyExists = () => {
  const e: any = new Error('ALREADY_EXISTS');
  e.code = 6;
  return e;
};

const createSync = (ref: DocRef, data: DocData) => {
  if (store.has(ref.path)) throw alreadyExists();
  store.set(ref.path, { ...data });
};

const setSync = (ref: DocRef, data: DocData, opts?: { merge?: boolean }) => {
  if (opts?.merge) {
    store.set(ref.path, { ...(store.get(ref.path) ?? {}), ...data });
  } else {
    store.set(ref.path, { ...data });
  }
};

class Query {
  constructor(private col: string, private field: string, private val: any) {}
  async get() {
    const docs = [...store.entries()]
      .filter(([p, d]) => p.startsWith(this.col + '/') && d[this.field] === this.val)
      .map(([p]) => makeSnap(new DocRef(p)));
    return { docs, empty: docs.length === 0 };
  }
}

class CollectionRef {
  constructor(public name: string) {}
  doc(id?: string) {
    return new DocRef(`${this.name}/${id ?? 'auto-' + ++idCounter}`);
  }
  where(field: string, _op: string, val: any) {
    return new Query(this.name, field, val);
  }
}

const db = {
  doc: (path: string) => new DocRef(path),
  collection: (name: string) => new CollectionRef(name),
  runTransaction: async (fn: (tx: any) => Promise<void> | void) => {
    const tx = {
      get: (target: any) => target.get(),
      getAll: (...refs: DocRef[]) => Promise.all(refs.map(r => r.get())),
      create: (ref: DocRef, data: DocData) => createSync(ref, data),
      set: (ref: DocRef, data: DocData, opts?: { merge?: boolean }) => setSync(ref, data, opts),
      update: (ref: DocRef, data: DocData) =>
        store.set(ref.path, { ...(store.get(ref.path) ?? {}), ...data }),
      delete: (ref: DocRef) => store.delete(ref.path),
    };
    return fn(tx);
  },
};

export const getFirestore = () => db;
export const FieldValue = {
  serverTimestamp: () => ({ __serverTimestamp: true }),
};
export const Timestamp = {
  now: () => ({ toMillis: () => Date.now() }),
  fromMillis: (ms: number) => ({ toMillis: () => ms }),
};
