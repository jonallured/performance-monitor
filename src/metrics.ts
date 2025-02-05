import FileSync from "lowdb/adapters/FileSync";
import low from "lowdb";
import { join } from "path";
import { chain, merge, flow } from "lodash";
import { isBefore, isEqual, isAfter, getTime, subWeeks } from "date-fns";
import Stats from "moving-average";

const adapter = new FileSync(join(process.cwd(), "data", "snapshot-db.json"));
const db = low(adapter);

db.defaults({ snapshots: [] }).write();

const deviceFromString = (string: string) => {
  let str = string.toLowerCase();
  if (str.includes("desktop")) return "desktop";
  if (str.includes("3g")) return "mobile";
  if (str.includes("4g")) return "mobile4g";
};

export const getSiteMetrics = (
  sitePattern: string,
  device: "desktop" | "mobile"
) => {
  const lastResults = flow([
    site =>
      fetchDeviceTestsInRange(
        site,
        subWeeks(new Date(), 2),
        subWeeks(new Date(), 4)
      ),
    result => calculateAverage(result, device),
    filterByMetricsWeCareAbout
  ])(sitePattern);

  let results = flow([
    fetchDeviceTestsInRange,
    result => calculateAverage(result, device),
    filterByMetricsWeCareAbout
  ])(sitePattern);

  for (let metric in results) {
    const { average } = results[metric];
    const { average: lastAverage } = lastResults[metric];

    let delta =
      Math.round(((average - lastAverage) / lastAverage) * 100).toString() +
      "%";
    delta = delta.includes("-") ? delta : `+${delta}`;
    results[metric].delta = delta;
  }

  return results;
};

/**
 * Uses cumulative moving average to calculate the average of each metric
 * https://en.wikipedia.org/wiki/Moving_average#Cumulative_moving_average
 */
const cumulativeMovingAverage = (
  currentAverage: number,
  x: number,
  n: number
) => (x + n * currentAverage) / (n + 1);

const normalizeDevice = (device: string) =>
  device === "MotoG4, 3G connection" ? "Mobile with 3G" : device;

export const getAllSiteMetrics = () =>
  chain(fetchAllTests())
    .map(test => ({
      url: test.url,
      key: `${test.page.name} | ${deviceFromString(test.testProfile.name)}`,
      page: test.page.name,
      device: deviceFromString(normalizeDevice(test.testProfile.name)),
      metrics: filterByMetricsWeCareAbout(test.measurements),
      createdAt: test.createdAt
    }))
    .filter(test => Object.keys(test.metrics).length > 0)
    .groupBy("key")

    .map((testGroup: any[]) =>
      testGroup.reduce(
        (prev, curr, n) => ({
          ...curr,
          ...prev,
          metrics: Object.entries(curr.metrics)
            .map(([metric, fields]: [string, any]) => {
              return {
                [metric]: {
                  ...fields,
                  value:
                    !prev.metrics || !prev.metrics[metric]
                      ? fields.value
                      : cumulativeMovingAverage(
                          prev.metrics[metric].value,
                          fields.value,
                          n
                        )
                }
              };
            })
            .reduce(merge, {})
        }),
        {}
      )
    )
    .groupBy("device")
    .value();

const fetchAllTests = () =>
  db
    .get("snapshots")
    .sortBy(s => s.iid)
    .map(snapshot =>
      snapshot.tests.map((test: any) => ({
        ...test,
        createdAt: snapshot.createdAt,
        url: snapshot.htmlUrl
      }))
    )
    .filter(tests => tests.length > 0)
    .flatten()
    .value();

const fetchDeviceTestsInRange = (
  page: string,
  startDate = new Date(),
  endDate = subWeeks(new Date(), 2)
) =>
  fetchAllTests()
    .filter((test: any) => test.page.url.includes(page))
    .filter(
      (test: any) =>
        isBefore(test.createdAt, startDate) ||
        isEqual(test.createdAt, startDate)
    )
    .filter(
      (test: any) =>
        isAfter(test.createdAt, endDate) || isEqual(test.createdAt, endDate)
    );

const filterByMetricsWeCareAbout = (avgMeasurements: any) => {
  const metrics = [
    "speed_index",
    "lighthouse-performance-score",
    "first-meaningful-paint",
    "first-contentful-paint"
  ];
  return avgMeasurements
    .filter((m: any) => metrics.includes(m.name))
    .reduce(
      (curr: any, prev: any) => ({
        ...curr,
        [prev.name]: prev
      }),
      {}
    );
};

const calculateAverage = (
  tests: any,
  device: "desktop" | "mobile" | "mobile4g"
) => {
  const firstDate = tests[0].createdAt;
  const deviceString =
    device === "desktop" ? "desktop" : device === "mobile" ? "3g" : "4g";
  return chain(tests)
    .map(test =>
      test.measurements.map((measurement: any) => ({
        ...measurement,
        createdAt: test.createdAt,
        page: test.page.url,
        device: test.testProfile.name
      }))
    )
    .flatten()
    .filter(test => test.device.toLowerCase().includes(deviceString))
    .groupBy("name")
    .map(measurements => {
      const { name, label, page, device } = measurements[0];
      const period = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
      const offset = getTime(firstDate);
      const stats = Stats(period);
      measurements.forEach(m =>
        stats.push(getTime(m.createdAt) - offset, m.value)
      );
      return {
        name,
        label,
        page,
        average: Math.round(stats.movingAverage()),
        device
      };
    })
    .value();
};
