// A small fixture database for exercising persistence without Atlas credentials.
// The live check separately verifies the real MongoDB driver and transaction path.
const { ObjectId } = require('mongodb');

function createMemoryDatabase() {
  let state = {};
  let failCollection = null;
  const writes = [];
  function copy(value) {
    if (value instanceof ObjectId) return new ObjectId(value.toHexString());
    if (value instanceof Date) return new Date(value);
    if (Array.isArray(value)) return value.map(copy);
    if (value && Object.getPrototypeOf(value) === Object.prototype) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)]));
    }
    return structuredClone(value);
  }
  const rows = (name) => (state[name] ||= []);
  // BSON order for the scalar types used in these fixtures, including mixed _id types.
  function compare(a, b) {
    const rank = value => value instanceof ObjectId ? 7 : value instanceof Date ? 9
      : typeof value === 'string' ? 2 : typeof value === 'number' ? 1 : 0;
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    const scalar = value => value instanceof ObjectId ? value.toHexString()
      : value instanceof Date ? value.getTime() : value;
    const left = scalar(a); const right = scalar(b);
    return left > right ? 1 : left < right ? -1 : 0;
  }
  function matches(document, filter) {
    return Object.entries(filter).every(([key, wanted]) => {
      if (key === '$or') return wanted.some(branch => matches(document, branch));
      if (key === '$expr') {
        const [field, literal] = wanted.$lt;
        return compare(document[field.slice(1)], literal.$literal) < 0;
      }
      const actual = document[key];
      if (wanted?.$regex) return new RegExp(wanted.$regex, wanted.$options).test(actual);
      if (wanted?.$in) return wanted.$in.some(value => compare(actual, value) === 0);
      if (wanted?.$gt !== undefined) return compare(actual, wanted.$gt) > 0;
      if (wanted?.$lt !== undefined) return compare(actual, wanted.$lt) < 0;
      return compare(actual, wanted) === 0;
    });
  }
  function sort(list, specification) {
    return list.sort((a, b) => {
      for (const [key, direction] of Object.entries(specification)) {
        const order = compare(a[key], b[key]);
        if (order) return order * direction;
      }
      return 0;
    });
  }
  function cursor(list) {
    let projection;
    let limit;
    return {
      sort(specification) { sort(list, specification); return this; },
      project(specification) { projection = specification; return this; },
      limit(count) { limit = count; return this; },
      async toArray() {
        if (limit !== undefined) list = list.slice(0, limit);
        if (!projection) return copy(list);
        const included = Object.keys(projection).filter((key) => projection[key] === 1);
        return copy(list.map((row) => {
          if (!included.length) return Object.fromEntries(Object.entries(row).filter(([key]) => projection[key] !== 0));
          const result = {};
          for (const key of included) {
            const path = key.split('.');
            let value = row;
            for (const part of path) value = value?.[part];
            if (value === undefined) continue;
            let target = result;
            for (const part of path.slice(0, -1)) target = (target[part] ||= {});
            target[path.at(-1)] = value;
          }
          return result;
        }));
      },
    };
  }
  const db = { collection(name) {
    return {
      find(filter) { return cursor(rows(name).filter((row) => matches(row, filter))); },
      async findOne(filter, options = {}) {
        const match = rows(name).find((row) => matches(row, filter));
        if (!match) return null;
        return options.projection ? (await cursor([match]).project(options.projection).toArray())[0] : copy(match);
      },
      async insertOne(document) {
        if (document._id && rows(name).some((row) => row._id === document._id)) {
          throw Object.assign(new Error('Duplicate fixture ID'), { code: 11000 });
        }
        rows(name).push(copy(document));
      },
      async updateOne(filter, update, options = {}) {
        writes.push({ name, session: options.session });
        if (name === failCollection) throw new Error('Simulated storage failure');
        const existing = rows(name).find((row) => matches(row, filter));
        if (existing) Object.assign(existing, copy(update.$set ?? {}));
        else if (options.upsert) rows(name).push(copy({ ...filter, ...update.$setOnInsert, ...update.$set }));
      },
      async deleteOne(filter) {
        const index = rows(name).findIndex((row) => matches(row, filter));
        if (index !== -1) rows(name).splice(index, 1);
      },
      aggregate(pipeline) {
        let list = copy(rows(name));
        for (const stage of pipeline) {
          if (stage.$match) list = list.filter((row) => matches(row, stage.$match));
          if (stage.$sort) sort(list, stage.$sort);
          if (stage.$group) {
            const seen = new Set();
            list = list.filter((row) => {
              const key = row[stage.$group._id.slice(1)];
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            });
          }
        }
        return cursor(list);
      },
    };
  } };
  async function transaction(work) {
    const before = copy(state);
    try { return await work(db, { fixtureSession: true }); } catch (error) { state = before; throw error; }
  }
  return { db, transaction, rows, writes, failOn: (name) => { failCollection = name; } };
}
module.exports = { createMemoryDatabase };
