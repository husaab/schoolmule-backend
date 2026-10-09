// Reads service metrics and deployments from Railway's public GraphQL API
// using a project token. Cached per window for 60 s so the console's live
// refresh cannot hammer Railway. Any failure degrades to available:false.
const ENDPOINT = 'https://backboard.railway.com/graphql/v2';
const CACHE_MS = 60 * 1000;
const MEASUREMENTS = ['CPU_USAGE', 'MEMORY_USAGE_GB', 'NETWORK_RX_GB', 'NETWORK_TX_GB'];
const SAMPLE_SECONDS = { '1h': 60, '24h': 900, '7d': 3600, '30d': 14400 };

const cache = new Map();

async function gql(query, variables) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Project-Access-Token': process.env.RAILWAY_TOKEN },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(10000),
  });
  const json = await res.json();
  if (json.errors && json.errors.length) throw new Error(json.errors[0].message || 'Railway API error');
  return json.data;
}

const METRICS_QUERY = `
  query Metrics($projectId: String!, $environmentId: String!, $serviceId: String!, $measurements: [MetricMeasurement!]!, $startDate: DateTime!, $endDate: DateTime!, $sampleRateSeconds: Int!) {
    metrics(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId, measurements: $measurements, startDate: $startDate, endDate: $endDate, sampleRateSeconds: $sampleRateSeconds) {
      measurement
      values { ts value }
    }
  }`;

const DEPLOYMENTS_QUERY = `
  query Deployments($projectId: String!, $environmentId: String!, $serviceId: String!) {
    deployments(first: 10, input: { projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId }) {
      edges { node { id status createdAt meta } }
    }
  }`;

const points = (metrics, name) => {
  const m = (metrics || []).find((x) => x.measurement === name);
  return (m ? m.values : []).map((v) => ({ ts: new Date(v.ts * 1000).toISOString(), value: Number(v.value) }));
};

async function fetchInfra(window) {
  const ids = {
    projectId: process.env.RAILWAY_PROJECT_ID,
    environmentId: process.env.RAILWAY_ENVIRONMENT_ID,
    serviceId: process.env.RAILWAY_SERVICE_ID,
  };
  const [metricsData, deployData] = await Promise.all([
    gql(METRICS_QUERY, {
      ...ids,
      measurements: MEASUREMENTS,
      startDate: window.from.toISOString(),
      endDate: window.to.toISOString(),
      sampleRateSeconds: SAMPLE_SECONDS[window.key] || 900,
    }),
    gql(DEPLOYMENTS_QUERY, ids),
  ]);
  const metrics = metricsData.metrics;
  const edges = (deployData.deployments && deployData.deployments.edges) || [];
  return {
    available: true,
    service: ids.serviceId,
    cpu: points(metrics, 'CPU_USAGE'),
    memoryGb: points(metrics, 'MEMORY_USAGE_GB'),
    networkRxGb: points(metrics, 'NETWORK_RX_GB'),
    networkTxGb: points(metrics, 'NETWORK_TX_GB'),
    deployments: edges.map(({ node }) => ({
      id: node.id,
      status: node.status,
      createdAt: node.createdAt,
      commitMessage: (node.meta && node.meta.commitMessage) || null,
      commitAuthor: (node.meta && node.meta.commitAuthor) || null,
      branch: (node.meta && node.meta.branch) || null,
    })),
  };
}

async function getInfra(window) {
  if (!process.env.RAILWAY_TOKEN) return { available: false, reason: 'RAILWAY_TOKEN is not set' };
  if (!process.env.RAILWAY_PROJECT_ID || !process.env.RAILWAY_ENVIRONMENT_ID || !process.env.RAILWAY_SERVICE_ID) {
    return { available: false, reason: 'RAILWAY_PROJECT_ID / RAILWAY_ENVIRONMENT_ID / RAILWAY_SERVICE_ID must be set' };
  }
  const hit = cache.get(window.key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  try {
    const data = await fetchInfra(window);
    cache.set(window.key, { at: Date.now(), data });
    return data;
  } catch (err) {
    return { available: false, reason: err.message || 'Railway request failed' };
  }
}

module.exports = { getInfra, _resetCache: () => cache.clear(), MEASUREMENTS };
