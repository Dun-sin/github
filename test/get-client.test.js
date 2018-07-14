import path from 'path';
import http from 'http';
import https from 'https';
import {promisify} from 'util';
import {readFile} from 'fs-extra';
import test from 'ava';
import {isFunction, isPlainObject, inRange} from 'lodash';
import {stub, spy} from 'sinon';
import proxyquire from 'proxyquire';
import Proxy from 'proxy';
import serverDestroy from 'server-destroy';
import rateLimit from './helpers/rate-limit';

const getClient = proxyquire('../lib/get-client', {'./definitions/rate-limit': rateLimit});

test.serial('Use a http proxy', async t => {
  const server = http.createServer();
  await promisify(server.listen).bind(server)();
  const serverPort = server.address().port;
  serverDestroy(server);
  const proxy = new Proxy();
  await promisify(proxy.listen).bind(proxy)();
  const proxyPort = proxy.address().port;
  serverDestroy(proxy);

  const proxyHandler = spy();
  const serverHandler = spy((req, res) => {
    res.end();
  });
  proxy.on('request', proxyHandler);
  server.on('request', serverHandler);

  const github = getClient({
    githubToken: 'github_token',
    githubUrl: `http://localhost:${serverPort}`,
    githubApiPathPrefix: '',
    proxy: `http://localhost:${proxyPort}`,
  });

  await github.repos.get({repo: 'repo', owner: 'owner'});

  t.is(proxyHandler.args[0][0].headers.accept, 'application/vnd.github.drax-preview+json');
  t.is(serverHandler.args[0][0].headers.accept, 'application/vnd.github.drax-preview+json');
  t.regex(serverHandler.args[0][0].headers.via, /proxy/);
  t.truthy(serverHandler.args[0][0].headers['x-forwarded-for'], /proxy/);

  await promisify(proxy.destroy).bind(proxy)();
  await promisify(server.destroy).bind(server)();
});

test.serial('Use a https proxy', async t => {
  const server = https.createServer({
    key: await readFile(path.join(__dirname, '/fixtures/ssl/ssl-cert-snakeoil.key')),
    cert: await readFile(path.join(__dirname, '/fixtures/ssl/ssl-cert-snakeoil.pem')),
  });
  await promisify(server.listen).bind(server)();
  const serverPort = server.address().port;
  serverDestroy(server);
  const proxy = new Proxy();
  await promisify(proxy.listen).bind(proxy)();
  const proxyPort = proxy.address().port;
  serverDestroy(proxy);

  const proxyHandler = spy();
  const serverHandler = spy((req, res) => {
    res.end();
  });
  proxy.on('connect', proxyHandler);
  server.on('request', serverHandler);

  const github = getClient({
    githubToken: 'github_token',
    githubUrl: `https://localhost:${serverPort}`,
    githubApiPathPrefix: '',
    proxy: {host: 'localhost', port: proxyPort, rejectUnauthorized: false, headers: {foo: 'bar'}},
  });

  await github.repos.get({repo: 'repo', owner: 'owner'});

  t.is(proxyHandler.args[0][0].url, `localhost:${serverPort}`);
  t.is(proxyHandler.args[0][0].headers.foo, 'bar');
  t.is(serverHandler.args[0][0].headers.accept, 'application/vnd.github.drax-preview+json');

  await promisify(proxy.destroy).bind(proxy)();
  await promisify(server.destroy).bind(server)();
});

test('Wrap Octokit in a proxy', t => {
  const github = getClient({githubToken: 'github_token'});

  t.true(Reflect.apply(Object.prototype.hasOwnProperty, github, ['repos']));
  t.true(isPlainObject(github.repos));
  t.true(Reflect.apply(Object.prototype.hasOwnProperty, github.repos, ['createRelease']));
  t.true(isFunction(github.repos.createRelease));

  t.true(Reflect.apply(Object.prototype.hasOwnProperty, github, ['search']));
  t.true(isPlainObject(github.search));
  t.true(Reflect.apply(Object.prototype.hasOwnProperty, github.search, ['issues']));
  t.true(isFunction(github.search.issues));

  t.falsy(github.unknown);
});

test('Use the global throttler for all endpoints', async t => {
  const createRelease = stub().callsFake(async () => Date.now());
  const createComment = stub().callsFake(async () => Date.now());
  const issues = stub().callsFake(async () => Date.now());
  const octokit = {repos: {createRelease}, issues: {createComment}, search: {issues}, authenticate: stub()};
  const rate = 150;
  const github = proxyquire('../lib/get-client', {
    '@octokit/rest': stub().returns(octokit),
    './definitions/rate-limit': {RATE_LIMITS: {search: 1, core: 1}, GLOBAL_RATE_LIMIT: rate},
  })();

  const a = await github.repos.createRelease();
  const b = await github.issues.createComment();
  const c = await github.repos.createRelease();
  const d = await github.issues.createComment();
  const e = await github.search.issues();
  const f = await github.search.issues();

  // `issues.createComment` should be called `rate` ms after `repos.createRelease`
  t.true(inRange(b - a, rate - 50, rate + 50));
  // `repos.createRelease` should be called `rate` ms after `issues.createComment`
  t.true(inRange(c - b, rate - 50, rate + 50));
  // `issues.createComment` should be called `rate` ms after `repos.createRelease`
  t.true(inRange(d - c, rate - 50, rate + 50));
  // `search.issues` should be called `rate` ms after `issues.createComment`
  t.true(inRange(e - d, rate - 50, rate + 50));
  // `search.issues` should be called `rate` ms after `search.issues`
  t.true(inRange(f - e, rate - 50, rate + 50));
});

test('Use the same throttler for endpoints in the same rate limit group', async t => {
  const createRelease = stub().callsFake(async () => Date.now());
  const createComment = stub().callsFake(async () => Date.now());
  const issues = stub().callsFake(async () => Date.now());
  const octokit = {repos: {createRelease}, issues: {createComment}, search: {issues}, authenticate: stub()};
  const searchRate = 300;
  const coreRate = 150;
  const github = proxyquire('../lib/get-client', {
    '@octokit/rest': stub().returns(octokit),
    './definitions/rate-limit': {RATE_LIMITS: {search: searchRate, core: coreRate}, GLOBAL_RATE_LIMIT: 1},
  })();

  const a = await github.repos.createRelease();
  const b = await github.issues.createComment();
  const c = await github.repos.createRelease();
  const d = await github.issues.createComment();
  const e = await github.search.issues();
  const f = await github.search.issues();

  // `issues.createComment` should be called `coreRate` ms after `repos.createRelease`
  t.true(inRange(b - a, coreRate - 50, coreRate + 50));
  // `repos.createRelease` should be called `coreRate` ms after `issues.createComment`
  t.true(inRange(c - b, coreRate - 50, coreRate + 50));
  // `issues.createComment` should be called `coreRate` ms after `repos.createRelease`
  t.true(inRange(d - c, coreRate - 50, coreRate + 50));

  // The first search should be called immediatly as it uses a different throttler
  t.true(inRange(e - d, -50, 50));
  // The second search should be called only after `searchRate` ms
  t.true(inRange(f - e, searchRate - 50, searchRate + 50));
});

test('Use the same throttler when retrying', async t => {
  const createRelease = stub().callsFake(async () => {
    const err = new Error();
    err.time = Date.now();
    err.code = 404;
    throw err;
  });

  const octokit = {repos: {createRelease}, authenticate: stub()};
  const coreRate = 200;
  const github = proxyquire('../lib/get-client', {
    '@octokit/rest': stub().returns(octokit),
    './definitions/rate-limit': {
      RETRY_CONF: {retries: 3, factor: 1, minTimeout: 1},
      RATE_LIMITS: {core: coreRate},
      GLOBAL_RATE_LIMIT: 1,
    },
  })();

  await t.throws(github.repos.createRelease());
  t.is(createRelease.callCount, 4);

  const {time: a} = await t.throws(createRelease.getCall(0).returnValue);
  const {time: b} = await t.throws(createRelease.getCall(1).returnValue);
  const {time: c} = await t.throws(createRelease.getCall(2).returnValue);
  const {time: d} = await t.throws(createRelease.getCall(3).returnValue);

  // Each retry should be done after `coreRate` ms
  t.true(inRange(b - a, coreRate - 50, coreRate + 50));
  t.true(inRange(c - b, coreRate - 50, coreRate + 50));
  t.true(inRange(d - c, coreRate - 50, coreRate + 50));
});
