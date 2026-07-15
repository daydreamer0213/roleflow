async function mapWithConcurrency(items, concurrency, worker) {
  const values = Array.from(items || []);
  if (!values.length) return [];
  const limit = Math.max(1, Math.min(values.length, Number.isInteger(Number(concurrency)) ? Number(concurrency) : 1));
  const results = new Array(values.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(values[index], index);
    }
  }

  await Promise.all(Array.from({ length: limit }, runWorker));
  return results;
}

module.exports = { mapWithConcurrency };
