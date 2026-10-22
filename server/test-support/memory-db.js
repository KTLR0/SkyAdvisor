// A small fixture database for exercising persistence without Atlas credentials.
// The live check separately verifies the real MongoDB driver and transaction path.
function createMemoryDatabase() {
  let state = {};
  let failCollection = null;
  const writes = [];
  const copy = (value) => structuredClone(value);
  const rows = (name) => (state[name] ||= []);
  function matches(document, filter) {
    return Object.entries(filter).every(([key, wanted]) => {
      const actual = document[key];
      if (wanted?.$regex) return new RegExp(wanted.$regex, wanted.$options).test(actual);
      if (wanted?.$in) return wanted.$in.includes(actual);
      if (wanted?.$gt !== undefined) return actual > wanted.$gt;
      return actual === wanted;
    });
  }
  function sort(list, specification) {
    return list.sort((a, b) => {
      for (const [key, direction] of Object.entries(specification)) {
        if (a[key] > b[key]) return direction;
        if (a[key] < b[key]) return -direction;
      }
      return 0;
    });
  }
  function cursor(list) {
    let projection;
    return {
      sort(specification) { sort(list, specification); return this; },
      project(specification) { projection = specification; return this; },
      async toArray() {
        if (!projection) return copy(list);
        const included = Object.keys(projection).filter((key) => projection[key] === 1);
        return copy(list.map((row) => included.length ? Object.fromEntries(included.map((key) => [key, row[key]]))
          : Object.fromEntries(Object.entries(row).filter(([key]) => projection[key] !== 0))));
      },
    };
  }
  const db = { collection(name) {
    return {
      find(filter) { return cursor(rows(name).filter((row) => matches(row, filter))); },
      async findOne(filter) { return copy(rows(name).find((row) => matches(row, filter)) ?? null); },
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
