/* Integration: the real Worker and the real local D1, over HTTP.
   Covers every collection the router exposes; each phase adds a section. */
// Same default as before; the override only exists so a future phase can
// point the same suite at a different local port.
const BASE = process.env.TAQWA_API_BASE || 'http://127.0.0.1:8787';
let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
};
const sec = (s) => console.log('\n-- ' + s + ' --');
async function get(path, init) {
  const res = await fetch(BASE + path, init);
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, ct: res.headers.get('content-type'), allow: res.headers.get('allow'), body };
}

sec('1. Health');
{
  const r = await get('/api/health');
  t('health 200', r.status === 200, r.status);
  t('health ok', r.body?.ok === true);
  t('database reachable', r.body?.data?.database?.reachable === true);
  t('migrated', r.body?.data?.database?.migrated === true);
  const routes = r.body?.data?.routes ?? [];
  t('advertises 15 routes', routes.length === 15, routes);
  t('advertises services list', routes.includes('GET /api/services'));
  t('advertises services detail', routes.includes('GET /api/services/:id'));
  t('advertises customers routes', routes.includes('GET /api/customers') && routes.includes('GET /api/customers/:id'));
  t('advertises vehicles routes', routes.includes('GET /api/vehicles') && routes.includes('GET /api/vehicles/:id'));
  t('advertises mechanics routes', routes.includes('GET /api/mechanics') && routes.includes('GET /api/mechanics/:id'));
  t('advertises parts routes', routes.includes('GET /api/parts') && routes.includes('GET /api/parts/:id'));
  t('advertises appointments routes', routes.includes('GET /api/appointments') && routes.includes('GET /api/appointments/:id'));
  t('advertises job-cards routes', routes.includes('GET /api/job-cards') && routes.includes('GET /api/job-cards/:id'));
}

sec('2. GET /api/services — list');
let list;
{
  const r = await get('/api/services');
  list = r.body;
  t('200', r.status === 200, r.status);
  t('json content-type', (r.ct || '').includes('application/json'), r.ct);
  t('no stray ok flag on list (envelope is {data,...meta})', !('ok' in list));
  t('data is an array', Array.isArray(list?.data));
  t('count 6', list?.count === 6, list?.count);
  t('total 6', list?.total === 6, list?.total);
  t('default limit 500', list?.limit === 500, list?.limit);
  t('default offset 0', list?.offset === 0, list?.offset);
  const ids = list.data.map(s => s.id);
  t('newest first, id DESC tie-break',
    JSON.stringify(ids) === JSON.stringify(['SRV-9006','SRV-9004','SRV-9003','SRV-9002','SRV-9001','SRV-9005']), ids);
}

sec('3. Record shape and NULL semantics');
{
  const byId = Object.fromEntries(list.data.map(s => [s.id, s]));
  const full = byId['SRV-9001'];
  t('camelCase keys only', Object.keys(full).every(k => !k.includes('_')), Object.keys(full));
  t('name', full.name === 'B4 Full Service', full.name);
  t('category', full.category === 'Engine');
  t('description', full.description === 'Complete engine overhaul');
  t('estTime is a number', full.estTime === 180, full.estTime);
  t('price is a number', full.price === 7500, full.price);
  t('status', full.status === 'Active');
  t('createdAt', full.createdAt === '2026-09-10T09:00:00', full.createdAt);
  t('updatedAt present when set', full.updatedAt === '2026-09-12T11:30:00', full.updatedAt);

  const sparse = byId['SRV-9002'];
  t('NULL category -> ""', sparse.category === '', sparse.category);
  t('NULL description -> ""', sparse.description === '', sparse.description);
  t('NULL est_time stays null, not 0', sparse.estTime === null, sparse.estTime);
  t('estTime is not 0', sparse.estTime !== 0);
  t('updatedAt omitted when NULL', !('updatedAt' in sparse), Object.keys(sparse));
  t('price keeps decimals', sparse.price === 1200.5, sparse.price);

  const retired = byId['SRV-9005'];
  t('Inactive status preserved', retired.status === 'Inactive', retired.status);
  t('price 0 stays 0', retired.price === 0, retired.price);
  t('est_time NULL -> null on inactive row', retired.estTime === null);

  const keys = new Set(list.data.flatMap(s => Object.keys(s)));
  t('no unexpected fields', [...keys].every(k =>
    ['id','name','category','description','estTime','price','status','createdAt','updatedAt'].includes(k)), [...keys]);
}

sec('4. Pagination');
{
  const r1 = await get('/api/services?limit=2');
  t('limit=2 returns 2', r1.body?.data?.length === 2, r1.body?.data?.length);
  t('limit echoed', r1.body?.limit === 2);
  t('total still 6', r1.body?.total === 6, r1.body?.total);
  t('count is page size', r1.body?.count === 2);

  const r2 = await get('/api/services?limit=2&offset=2');
  t('offset=2 returns next page', JSON.stringify(r2.body.data.map(s => s.id)) === JSON.stringify(['SRV-9003','SRV-9002']),
    r2.body.data.map(s => s.id));
  t('offset echoed', r2.body?.offset === 2);
  t('pages do not overlap', !r2.body.data.some(s => r1.body.data.find(x => x.id === s.id)));

  const r3 = await get('/api/services?offset=100');
  t('offset past end -> empty array', Array.isArray(r3.body?.data) && r3.body.data.length === 0);
  t('offset past end still 200', r3.status === 200);
  t('total unaffected by offset', r3.body?.total === 6);

  const r4 = await get('/api/services?limit=1000');
  t('max limit accepted', r4.status === 200);
}

sec('5. Invalid list parameters -> 400');
for (const [q, why] of [['limit=0','limit below min'], ['limit=1001','limit above max'], ['limit=abc','limit not a number'],
                        ['limit=1.5','limit not an integer'], ['offset=-1','offset negative'], ['offset=xyz','offset not a number']]) {
  const r = await get('/api/services?' + q);
  t(`${why} -> 400`, r.status === 400, { q, status: r.status });
  t(`${why} -> invalid_parameter`, r.body?.error?.code === 'invalid_parameter', r.body?.error);
  t(`${why} -> no data key on failure`, !('data' in r.body));
}

sec('6. GET /api/services/:id — detail');
{
  const r = await get('/api/services/SRV-9001');
  t('200', r.status === 200, r.status);
  t('no stray ok flag on detail', !('ok' in r.body));
  t('data is an object, not an array', r.body?.data && !Array.isArray(r.body.data));
  t('id matches', r.body?.data?.id === 'SRV-9001');
  const fromList = list.data.find(s => s.id === 'SRV-9001');
  t('detail record identical to list record', JSON.stringify(r.body.data) === JSON.stringify(fromList));
  t('no list meta on detail', r.body.count === undefined && r.body.total === undefined && r.body.limit === undefined);

  const r2 = await get('/api/services/SRV-9002');
  t('sparse detail keeps estTime null', r2.body?.data?.estTime === null);
  t('sparse detail omits updatedAt', !('updatedAt' in r2.body.data));
}

sec('7. Detail error paths');
{
  const r404 = await get('/api/services/SRV-8888');
  t('unknown id -> 404', r404.status === 404, r404.status);
  t('404 code', r404.body?.error?.code === 'not_found', r404.body?.error);
  t('404 message names a service', r404.body?.error?.message === 'No service with that id.', r404.body?.error?.message);

  const rWrong = await get('/api/services/VEH-9001');
  t('well-formed id from another collection -> 404 not 400', rWrong.status === 404, rWrong.status);
  t('cross-collection 404 message', rWrong.body?.error?.message === 'No service with that id.');

  for (const [id, why] of [['nonsense','no prefix shape'], ['SRV-','no number'], ['-9001','no prefix'],
                           ['SRVICES-9001','prefix too long'], ['S-1','prefix too short'], ['SRV-99999999999','number too long']]) {
    const r = await get('/api/services/' + encodeURIComponent(id));
    t(`${why} -> 400`, r.status === 400, { id, status: r.status });
    t(`${why} -> invalid_id`, r.body?.error?.code === 'invalid_id', r.body?.error);
  }

  const rEmpty = await get('/api/services/');
  t('trailing slash -> 400 not 404', rEmpty.status === 400, rEmpty.status);
  t('trailing slash code', rEmpty.body?.error?.code === 'invalid_id');

  const rBadEscape = await fetch(BASE + '/api/services/%zz');
  t('malformed percent-escape -> 400', rBadEscape.status === 400, rBadEscape.status);

  const rInject = await get('/api/services/' + encodeURIComponent("SRV-9001' OR '1'='1"));
  t('SQL-ish id rejected by validator -> 400', rInject.status === 400, rInject.status);
  const after = await get('/api/services');
  t('table intact after injection attempt', after.body?.total === 6, after.body?.total);
}

sec('8. Method handling');
for (const m of ['POST','PUT','DELETE','PATCH']) {
  const rl = await get('/api/services', { method: m });
  t(`${m} list -> 405`, rl.status === 405, rl.status);
  t(`${m} list sets Allow: GET`, rl.allow === 'GET', rl.allow);
  const rd = await get('/api/services/SRV-9001', { method: m });
  t(`${m} detail -> 405`, rd.status === 405, rd.status);
  t(`${m} detail sets Allow: GET`, rd.allow === 'GET', rd.allow);
}
{
  const r = await get('/api/services', { method: 'HEAD' });
  t('HEAD -> 405 (only GET is implemented)', r.status === 405, r.status);
}

sec('9. Customers regression — unchanged by the shared factory');
{
  const r = await get('/api/customers');
  t('200', r.status === 200, r.status);
  t('count 2', r.body?.count === 2, r.body?.count);
  t('total 2', r.body?.total === 2);
  t('meta keys unchanged', JSON.stringify(Object.keys(r.body).sort()) === JSON.stringify(['count','data','limit','offset','total']),
    Object.keys(r.body));
  const c = r.body.data.find(x => x.id === 'CUS-9001');
  t('full customer record shape', JSON.stringify(c) === JSON.stringify({
    id:'CUS-9001', name:'B4 Test Customer', phone:'01900000001', altPhone:'01900000002',
    email:'b4@example.test', address:'Dhaka', notes:'regression row', status:'Active',
    createdAt:'2026-09-10T09:00:00', updatedAt:'2026-09-12T10:00:00' }), c);
  const sparse = r.body.data.find(x => x.id === 'CUS-9002');
  t('sparse customer nulls -> ""', sparse.altPhone === '' && sparse.email === '' && sparse.address === '' && sparse.notes === '');
  t('sparse customer omits updatedAt', !('updatedAt' in sparse));
  t('phone_digits never leaks', !('phoneDigits' in c) && !('phone_digits' in c), Object.keys(c));
  t('ordering newest first', JSON.stringify(r.body.data.map(x => x.id)) === JSON.stringify(['CUS-9002','CUS-9001']));

  const d = await get('/api/customers/CUS-9001');
  t('detail 200', d.status === 200);
  t('detail matches list record', JSON.stringify(d.body.data) === JSON.stringify(c));
  const d404 = await get('/api/customers/CUS-8888');
  t('customers 404 message unchanged', d404.status === 404 && d404.body?.error?.message === 'No customer with that id.', d404.body?.error);
  const d400 = await get('/api/customers/bad');
  t('customers 400 unchanged', d400.status === 400 && d400.body?.error?.code === 'invalid_id');
  const dCross = await get('/api/customers/SRV-9001');
  t('services id on customers route -> 404', dCross.status === 404 && dCross.body?.error?.message === 'No customer with that id.');
  const p = await get('/api/customers?limit=1&offset=1');
  t('customers pagination unchanged', p.body?.count === 1 && p.body?.total === 2 && p.body.data[0].id === 'CUS-9001', p.body);
  const m405 = await get('/api/customers', { method: 'POST' });
  t('customers 405 unchanged', m405.status === 405 && m405.allow === 'GET');
}

sec('10. Vehicles regression — unchanged by the shared factory');
{
  const r = await get('/api/vehicles');
  t('200', r.status === 200, r.status);
  t('count 2', r.body?.count === 2, r.body?.count);
  const v = r.body.data.find(x => x.id === 'VEH-9001');
  t('full vehicle record shape', JSON.stringify(v) === JSON.stringify({
    id:'VEH-9001', customerId:'CUS-9001', regNo:'B4-TEST-01', brand:'Toyota', model:'Corolla',
    year:2019, color:'White', vin:'VIN9001', engineNo:'ENG9001', chassisNo:'CHS9001', mileage:52000,
    fuelType:'Petrol', transmission:'Automatic', nextServiceDate:'2026-12-01', notes:'regression row',
    status:'Active', createdAt:'2026-09-10T09:00:00', updatedAt:'2026-09-12T10:00:00' }), v);
  const sparse = r.body.data.find(x => x.id === 'VEH-9002');
  t('vehicle year null, not 0', sparse.year === null, sparse.year);
  t('vehicle mileage null, not 0', sparse.mileage === null, sparse.mileage);
  t('vehicle text nulls -> ""', sparse.color === '' && sparse.vin === '' && sparse.fuelType === '' && sparse.nextServiceDate === '');
  t('vehicle omits updatedAt', !('updatedAt' in sparse));
  const d = await get('/api/vehicles/VEH-9001');
  t('detail 200', d.status === 200);
  t('detail matches list record', JSON.stringify(d.body.data) === JSON.stringify(v));
  const d404 = await get('/api/vehicles/VEH-8888');
  t('vehicles 404 message unchanged', d404.status === 404 && d404.body?.error?.message === 'No vehicle with that id.', d404.body?.error);
  const dCross = await get('/api/vehicles/SRV-9001');
  t('services id on vehicles route -> 404', dCross.status === 404 && dCross.body?.error?.message === 'No vehicle with that id.');
  const m405 = await get('/api/vehicles/VEH-9001', { method: 'DELETE' });
  t('vehicles 405 unchanged', m405.status === 405 && m405.allow === 'GET');
}

sec('10b. GET /api/mechanics — the new collection, over real HTTP');
{
  const r = await get('/api/mechanics');
  t('200', r.status === 200, r.status);
  t('count 3', r.body?.count === 3, r.body?.count);
  t('total 3', r.body?.total === 3, r.body?.total);
  t('meta keys match the other collections',
    JSON.stringify(Object.keys(r.body).sort()) === JSON.stringify(['count','data','limit','offset','total']),
    Object.keys(r.body));
  t('newest first, id DESC tie-break',
    JSON.stringify(r.body.data.map(m => m.id)) === JSON.stringify(['MEC-9002','MEC-9001','MEC-9003']),
    r.body.data.map(m => m.id));

  const byId = Object.fromEntries(r.body.data.map(m => [m.id, m]));
  const full = byId['MEC-9001'];
  t('full mechanic record shape', JSON.stringify(full) === JSON.stringify({
    id:'MEC-9001', name:'B5 Full Mechanic', phone:'01911000001', altPhone:'01911000002',
    email:'b5@example.test', address:'Uttara, Dhaka', specialization:'Engine & Transmission',
    experience:12, joiningDate:'2021-03-15', employmentType:'Full Time', salaryType:'Monthly',
    salary:32000, commissionRate:5.5, availability:'Available', notes:'regression row',
    status:'Active', createdAt:'2026-09-10T09:00:00', updatedAt:'2026-09-12T10:00:00' }), full);
  t('camelCase keys only', Object.keys(full).every(k => !k.includes('_')), Object.keys(full));
  t('commissionRate keeps its decimal', full.commissionRate === 5.5, full.commissionRate);

  const sparse = byId['MEC-9002'];
  t('NULL text -> ""',
    sparse.altPhone === '' && sparse.email === '' && sparse.address === ''
      && sparse.specialization === '' && sparse.joiningDate === '' && sparse.notes === '');
  t('NULL experience stays null, not 0', sparse.experience === null, sparse.experience);
  t('NULL salary stays null, not 0', sparse.salary === null, sparse.salary);
  t('NULL commissionRate stays null, not 0', sparse.commissionRate === null, sparse.commissionRate);
  t('NULL employmentType -> "", API invents no default', sparse.employmentType === '', sparse.employmentType);
  t('NULL salaryType -> "", API invents no default', sparse.salaryType === '', sparse.salaryType);
  t('NULL availability -> "", API invents no default', sparse.availability === '', sparse.availability);
  t('sparse mechanic omits updatedAt', !('updatedAt' in sparse), Object.keys(sparse));

  const zeroed = byId['MEC-9003'];
  t('stored 0 experience stays 0', zeroed.experience === 0, zeroed.experience);
  t('stored 0 salary stays 0', zeroed.salary === 0, zeroed.salary);
  t('stored 0 commissionRate stays 0', zeroed.commissionRate === 0, zeroed.commissionRate);
  t('0 is distinguishable from null over the wire',
    zeroed.salary === 0 && sparse.salary === null, { zero: zeroed.salary, nul: sparse.salary });
  t('Inactive status preserved', zeroed.status === 'Inactive', zeroed.status);

  const p1 = await get('/api/mechanics?limit=2');
  t('limit=2 returns 2', p1.body?.data?.length === 2, p1.body?.data?.length);
  t('total still 3', p1.body?.total === 3, p1.body?.total);
  const p2 = await get('/api/mechanics?limit=2&offset=2');
  t('offset=2 returns the last one', JSON.stringify(p2.body.data.map(m => m.id)) === JSON.stringify(['MEC-9003']),
    p2.body.data.map(m => m.id));
  t('pages do not overlap', !p2.body.data.some(m => p1.body.data.find(x => x.id === m.id)));
  const p3 = await get('/api/mechanics?offset=99');
  t('offset past end -> empty array, still 200', p3.status === 200 && p3.body.data.length === 0);

  for (const [q, why] of [['limit=0','limit below min'], ['limit=1001','limit above max'],
                          ['limit=abc','limit not a number'], ['offset=-1','offset negative']]) {
    const bad = await get('/api/mechanics?' + q);
    t(`${why} -> 400`, bad.status === 400 && bad.body?.error?.code === 'invalid_parameter', { q, status: bad.status });
  }

  const d = await get('/api/mechanics/MEC-9001');
  t('detail 200', d.status === 200, d.status);
  t('detail matches the list record', JSON.stringify(d.body.data) === JSON.stringify(full));
  t('no list meta on detail', d.body.count === undefined && d.body.limit === undefined);
  const dSparse = await get('/api/mechanics/MEC-9002');
  t('sparse detail keeps salary null', dSparse.body?.data?.salary === null, dSparse.body?.data?.salary);

  const d404 = await get('/api/mechanics/MEC-8888');
  t('unknown id -> 404', d404.status === 404, d404.status);
  t('404 message names a mechanic', d404.body?.error?.message === 'No mechanic with that id.', d404.body?.error?.message);
  const dCross = await get('/api/mechanics/SRV-9001');
  t('another collection\'s id -> 404, not 400', dCross.status === 404, dCross.status);
  t('cross-collection 404 message', dCross.body?.error?.message === 'No mechanic with that id.');
  const mOnCust = await get('/api/customers/MEC-9001');
  t('mechanics id on the customers route -> 404', mOnCust.status === 404 && mOnCust.body?.error?.message === 'No customer with that id.');

  for (const [id, why] of [['nonsense','no prefix shape'], ['MEC-','no number'], ['-9001','no prefix'],
                           ['MECHANICS-9001','prefix too long'], ['M-1','prefix too short']]) {
    const bad = await get('/api/mechanics/' + encodeURIComponent(id));
    t(`${why} -> 400`, bad.status === 400 && bad.body?.error?.code === 'invalid_id', { id, status: bad.status });
  }
  const dEmpty = await get('/api/mechanics/');
  t('trailing slash -> 400', dEmpty.status === 400 && dEmpty.body?.error?.code === 'invalid_id');
  const dEsc = await fetch(BASE + '/api/mechanics/%zz');
  t('malformed percent-escape -> 400', dEsc.status === 400, dEsc.status);

  const inject = await get('/api/mechanics/' + encodeURIComponent("MEC-9001' OR '1'='1"));
  t('SQL-ish id rejected -> 400', inject.status === 400, inject.status);
  const after = await get('/api/mechanics');
  t('mechanics table intact after injection attempt', after.body?.total === 3, after.body?.total);

  for (const m of ['POST','PUT','DELETE','PATCH']) {
    const rl = await get('/api/mechanics', { method: m });
    t(`${m} list -> 405 + Allow`, rl.status === 405 && rl.allow === 'GET', { status: rl.status, allow: rl.allow });
    const rd = await get('/api/mechanics/MEC-9001', { method: m });
    t(`${m} detail -> 405 + Allow`, rd.status === 405 && rd.allow === 'GET', { status: rd.status, allow: rd.allow });
  }
}

sec('10c. GET /api/parts — stock comes from the column, not the ledger');
{
  const r = await get('/api/parts');
  t('200', r.status === 200, r.status);
  t('count 3', r.body?.count === 3, r.body?.count);
  t('total 3', r.body?.total === 3, r.body?.total);
  t('meta keys match the other collections',
    JSON.stringify(Object.keys(r.body).sort()) === JSON.stringify(['count','data','limit','offset','total']),
    Object.keys(r.body));
  t('newest first, id DESC tie-break',
    JSON.stringify(r.body.data.map(p => p.id)) === JSON.stringify(['PRT-9002','PRT-9001','PRT-9003']),
    r.body.data.map(p => p.id));

  const byId = Object.fromEntries(r.body.data.map(p => [p.id, p]));
  const full = byId['PRT-9001'];
  t('full part record shape', JSON.stringify(full) === JSON.stringify({
    id:'PRT-9001', name:'B6 Full Part', partNo:'B6-OF-001', category:'Filters',
    brand:'Toyota', supplier:'Dhaka Auto Parts', location:'Rack A2', unit:'pc',
    purchasePrice:350, sellingPrice:500, stock:18, minStock:8, reorderQty:10,
    notes:'regression row', status:'Active', createdAt:'2026-09-10T09:00:00',
    updatedAt:'2026-09-12T10:00:00' }), full);
  t('camelCase keys only', Object.keys(full).every(k => !k.includes('_')), Object.keys(full));

  const sparse = byId['PRT-9002'];
  t('NULL text -> ""',
    sparse.partNo === '' && sparse.category === '' && sparse.brand === ''
      && sparse.supplier === '' && sparse.location === '' && sparse.unit === ''
      && sparse.notes === '');
  t('NULL reorderQty stays null — the UI supplies its own default',
    sparse.reorderQty === null, sparse.reorderQty);
  t('NOT NULL numbers always arrive as numbers',
    typeof sparse.purchasePrice === 'number' && typeof sparse.sellingPrice === 'number'
      && typeof sparse.stock === 'number' && typeof sparse.minStock === 'number');
  t('sparse part omits updatedAt', !('updatedAt' in sparse), Object.keys(sparse));

  const zero = byId['PRT-9003'];
  t('stock 0 stays 0 — out of stock is a real state', zero.stock === 0, zero.stock);
  t('reorderQty stored as 0 stays 0', zero.reorderQty === 0, zero.reorderQty);
  t('a stored 0 and a NULL are distinguishable over the wire',
    zero.reorderQty === 0 && sparse.reorderQty === null,
    { stored: zero.reorderQty, absent: sparse.reorderQty });
  t('Inactive status preserved', zero.status === 'Inactive', zero.status);

  // The API reports the stored balance. Nothing here is summed, joined or
  // reconciled against inventory_transactions.
  const keys = new Set(r.body.data.flatMap(p => Object.keys(p)));
  t('no derived low-stock flag', ![...keys].some(k => /low|alert|needsReorder/i.test(k)), [...keys]);
  t('no derived stock value', ![...keys].some(k => /value|worth/i.test(k)), [...keys]);
  t('no embedded transaction history',
    ![...keys].some(k => /transaction|history|movement|ledger/i.test(k)), [...keys]);
  t('no openingStock — it is not a stored column', !keys.has('openingStock'), [...keys]);

  const p1 = await get('/api/parts?limit=2');
  t('limit=2 returns 2', p1.body?.data?.length === 2, p1.body?.data?.length);
  t('total still 3', p1.body?.total === 3, p1.body?.total);
  const p2 = await get('/api/parts?limit=2&offset=2');
  t('offset=2 returns the last one', JSON.stringify(p2.body.data.map(p => p.id)) === JSON.stringify(['PRT-9003']),
    p2.body.data.map(p => p.id));
  t('pages do not overlap', !p2.body.data.some(p => p1.body.data.find(x => x.id === p.id)));
  const p3 = await get('/api/parts?offset=99');
  t('offset past end -> empty array, still 200', p3.status === 200 && p3.body.data.length === 0);
  const p4 = await get('/api/parts?limit=1000');
  t('limit at the maximum accepted', p4.status === 200, p4.status);

  for (const [q, why] of [['limit=0','limit below min'], ['limit=1001','limit above max'],
                          ['limit=abc','limit not a number'], ['offset=-1','offset negative']]) {
    const bad = await get('/api/parts?' + q);
    t(`${why} -> 400`, bad.status === 400 && bad.body?.error?.code === 'invalid_parameter', { q, status: bad.status });
  }

  const d = await get('/api/parts/PRT-9001');
  t('detail 200', d.status === 200, d.status);
  t('detail matches the list record', JSON.stringify(d.body.data) === JSON.stringify(full));
  t('no list meta on detail', d.body.count === undefined && d.body.limit === undefined);
  const dZero = await get('/api/parts/PRT-9003');
  t('out-of-stock detail reports 0', dZero.body?.data?.stock === 0, dZero.body?.data?.stock);
  const dSparse = await get('/api/parts/PRT-9002');
  t('sparse detail keeps reorderQty null', dSparse.body?.data?.reorderQty === null, dSparse.body?.data?.reorderQty);

  const d404 = await get('/api/parts/PRT-8888');
  t('unknown id -> 404', d404.status === 404, d404.status);
  t('404 message names a part', d404.body?.error?.message === 'No part with that id.', d404.body?.error?.message);
  for (const other of ['MEC-9001', 'SRV-9001', 'CUS-9001', 'VEH-9001']) {
    const x = await get('/api/parts/' + other);
    t(`${other} on the parts route -> 404, not 400`, x.status === 404, x.status);
  }
  const pOnMech = await get('/api/mechanics/PRT-9001');
  t('parts id on the mechanics route -> 404',
    pOnMech.status === 404 && pOnMech.body?.error?.message === 'No mechanic with that id.');

  for (const [id, why] of [['nonsense','no prefix shape'], ['PRT-','no number'], ['-9001','no prefix'],
                           ['PARTSXX-9001','prefix too long'], ['P-1','prefix too short']]) {
    const bad = await get('/api/parts/' + encodeURIComponent(id));
    t(`${why} -> 400`, bad.status === 400 && bad.body?.error?.code === 'invalid_id', { id, status: bad.status });
  }
  const dEmpty = await get('/api/parts/');
  t('trailing slash -> 400', dEmpty.status === 400 && dEmpty.body?.error?.code === 'invalid_id');
  const dEsc = await fetch(BASE + '/api/parts/%zz');
  t('malformed percent-escape -> 400', dEsc.status === 400, dEsc.status);

  // An injection that would zero the stock if it ever reached the database.
  const inject = await get('/api/parts/' + encodeURIComponent("PRT-9001'; UPDATE parts SET stock=0 --"));
  t('stock-mutating injection rejected -> 400', inject.status === 400, inject.status);
  const after = await get('/api/parts/PRT-9001');
  t('stock is untouched after the injection attempt', after.body?.data?.stock === 18, after.body?.data?.stock);
  const allAfter = await get('/api/parts');
  t('parts table intact after injection attempt', allAfter.body?.total === 3, allAfter.body?.total);

  for (const m of ['POST','PUT','DELETE','PATCH']) {
    const rl = await get('/api/parts', { method: m });
    t(`${m} list -> 405 + Allow`, rl.status === 405 && rl.allow === 'GET', { status: rl.status, allow: rl.allow });
    const rd = await get('/api/parts/PRT-9001', { method: m });
    t(`${m} detail -> 405 + Allow`, rd.status === 405 && rd.allow === 'GET', { status: rd.status, allow: rd.allow });
  }

  // The ledger is deliberately not exposed in this phase.
  for (const path of ['/api/inventory-transactions', '/api/inventory']) {
    const x = await get(path);
    t(`${path} is not a route yet -> 404`, x.status === 404, x.status);
  }
}

sec('10d. GET /api/appointments — references stay as ids, values as stored');
{
  const SOURCES = ['Admin','Phone','Walk-in','Facebook','Website'];
  const r = await get('/api/appointments');
  t('200', r.status === 200, r.status);
  t('count 6', r.body?.count === 6, r.body?.count);
  t('total 6', r.body?.total === 6, r.body?.total);
  t('meta keys match the other collections',
    JSON.stringify(Object.keys(r.body).sort()) === JSON.stringify(['count','data','limit','offset','total']),
    Object.keys(r.body));
  t('newest first by created_at, not by appointment date',
    JSON.stringify(r.body.data.map(a => a.id)) ===
      JSON.stringify(['APT-9006','APT-9005','APT-9004','APT-9003','APT-9002','APT-9001']),
    r.body.data.map(a => a.id));

  const byId = Object.fromEntries(r.body.data.map(a => [a.id, a]));

  const full = byId['APT-9002'];
  t('full appointment record shape', JSON.stringify(full) === JSON.stringify({
    id:'APT-9002', customerId:'CUS-9001', vehicleId:'VEH-9001', serviceId:'SRV-9002',
    mechanicId:'MEC-9001', jobCardId:null, date:'2026-09-21', time:'09:30', duration:60,
    status:'Confirmed', source:'Phone', complaint:'Battery draining overnight',
    notes:'Call before arrival', reminderSent:true, createdAt:'2026-09-11T09:00:00',
    updatedAt:'2026-09-12T10:00:00' }), full);
  t('camelCase keys only', Object.keys(full).every(k => !k.includes('_')), Object.keys(full));

  const sparse = byId['APT-9001'];
  t('NULL mechanic_id -> null, not ""', sparse.mechanicId === null, sparse.mechanicId);
  t('NULL job_card_id -> null, not ""', sparse.jobCardId === null, sparse.jobCardId);
  t('NULL complaint -> ""', sparse.complaint === '', sparse.complaint);
  t('NULL notes -> ""', sparse.notes === '', sparse.notes);
  t('sparse appointment omits updatedAt', !('updatedAt' in sparse), Object.keys(sparse));
  t('NOT NULL references always present',
    Boolean(sparse.customerId && sparse.vehicleId && sparse.serviceId),
    { c: sparse.customerId, v: sparse.vehicleId, s: sparse.serviceId });

  // reminder_sent is INTEGER 0/1 in D1 and a boolean in the app.
  t('reminder_sent 1 -> true', full.reminderSent === true, full.reminderSent);
  t('reminder_sent 0 -> false', sparse.reminderSent === false, sparse.reminderSent);
  t('reminderSent is a boolean over the wire, never 0/1',
    r.body.data.every(a => typeof a.reminderSent === 'boolean'),
    r.body.data.map(a => a.reminderSent));

  // Job card link, observed in both states against a real foreign key.
  const linked = byId['APT-9004'];
  t('a linked appointment reports its job card id', linked.jobCardId === 'JOB-9001', linked.jobCardId);
  t('the link is an id, not an embedded job card object', typeof linked.jobCardId === 'string');
  t('unlinked appointments report null, not the linked id',
    r.body.data.filter(a => a.jobCardId === null).length === 5,
    r.body.data.map(a => a.jobCardId));

  // Nothing is joined: no customer/vehicle/service/mechanic/job-card fields.
  const keys = new Set(r.body.data.flatMap(a => Object.keys(a)));
  t('no joined customer data', !['customerName','customer','customerPhone'].some(k => keys.has(k)), [...keys]);
  t('no joined vehicle data', !['vehicleName','vehicle','regNo','brand'].some(k => keys.has(k)), [...keys]);
  t('no joined service data', !['serviceName','service','price'].some(k => keys.has(k)), [...keys]);
  t('no joined mechanic data', !['mechanicName','mechanic','salary'].some(k => keys.has(k)), [...keys]);
  t('no joined job card data', !['jobCard','jobCardStatus','total'].some(k => keys.has(k)), [...keys]);
  t('exactly the five reference ids',
    ['customerId','vehicleId','serviceId','mechanicId','jobCardId'].every(k => keys.has(k)), [...keys]);

  // All five canonical sources, returned exactly as stored.
  const sources = r.body.data.map(a => a.source);
  t('Admin present', sources.includes('Admin'));
  t('Phone present', sources.includes('Phone'));
  t('Walk-in present', sources.includes('Walk-in'));
  t('Facebook present — not rewritten to Website', sources.includes('Facebook'), sources);
  t('Website present — not inferred from anything else', sources.includes('Website'), sources);
  t('every source is canonical', sources.every(s => SOURCES.includes(s)), sources);
  t('no source gained a suffix', sources.every(s => s === s.trim() && !s.includes('-api')), sources);
  t('Facebook and Website are distinct rows',
    byId['APT-9004'].source === 'Facebook' && byId['APT-9005'].source === 'Website');

  // Statuses, returned exactly as stored.
  const statuses = r.body.data.map(a => a.status);
  for (const s of ['Scheduled','Confirmed','In Progress','Completed','Cancelled','No Show']) {
    t(`status "${s}" round-trips`, statuses.includes(s), statuses);
  }
  t('"In Progress" keeps its space', byId['APT-9003'].status === 'In Progress', byId['APT-9003'].status);
  t('"No Show" keeps its space', byId['APT-9006'].status === 'No Show', byId['APT-9006'].status);

  // Date and time: stored text, returned unchanged. Midnight and 23:59 are
  // where a UTC round trip would move the day for Dhaka (UTC+6).
  t('midnight stays midnight on its own date',
    sparse.date === '2026-09-20' && sparse.time === '00:00', { d: sparse.date, t: sparse.time });
  t('23:59 stays on its own date',
    linked.date === '2026-09-23' && linked.time === '23:59', { d: linked.date, t: linked.time });
  t('an early-morning slot is not shifted',
    byId['APT-9006'].date === '2026-09-25' && byId['APT-9006'].time === '05:30');
  t('every date is a plain yyyy-mm-dd string',
    r.body.data.every(a => /^\d{4}-\d{2}-\d{2}$/.test(a.date)), r.body.data.map(a => a.date));
  t('every time is a plain HH:MM string',
    r.body.data.every(a => /^\d{2}:\d{2}$/.test(a.time)), r.body.data.map(a => a.time));
  t('no date became an ISO timestamp',
    !r.body.data.some(a => a.date.includes('T') || a.date.endsWith('Z')), r.body.data.map(a => a.date));
  t('duration is always a number', r.body.data.every(a => typeof a.duration === 'number'),
    r.body.data.map(a => a.duration));
  t('the 600-minute maximum survives', byId['APT-9006'].duration === 600, byId['APT-9006'].duration);

  // Pagination.
  const p1 = await get('/api/appointments?limit=2');
  t('limit=2 returns 2', p1.body?.data?.length === 2, p1.body?.data?.length);
  t('total still 6', p1.body?.total === 6, p1.body?.total);
  const p2 = await get('/api/appointments?limit=2&offset=2');
  t('offset=2 returns the next page',
    JSON.stringify(p2.body.data.map(a => a.id)) === JSON.stringify(['APT-9004','APT-9003']),
    p2.body.data.map(a => a.id));
  t('pages do not overlap', !p2.body.data.some(a => p1.body.data.find(x => x.id === a.id)));
  const p3 = await get('/api/appointments?offset=99');
  t('offset past end -> empty array, still 200', p3.status === 200 && p3.body.data.length === 0);
  const p4 = await get('/api/appointments?limit=1000');
  t('limit at the maximum accepted', p4.status === 200, p4.status);
  for (const [q, why] of [['limit=0','limit below min'], ['limit=1001','limit above max'],
                          ['limit=abc','limit not a number'], ['offset=-1','offset negative']]) {
    const bad = await get('/api/appointments?' + q);
    t(`${why} -> 400`, bad.status === 400 && bad.body?.error?.code === 'invalid_parameter', { q, status: bad.status });
  }

  // Detail.
  const d = await get('/api/appointments/APT-9002');
  t('detail 200', d.status === 200, d.status);
  t('detail matches the list record', JSON.stringify(d.body.data) === JSON.stringify(full));
  t('no list meta on detail', d.body.count === undefined && d.body.limit === undefined);
  const dLinked = await get('/api/appointments/APT-9004');
  t('linked detail reports the job card id', dLinked.body?.data?.jobCardId === 'JOB-9001', dLinked.body?.data?.jobCardId);
  const dSparse = await get('/api/appointments/APT-9001');
  t('sparse detail keeps mechanicId null', dSparse.body?.data?.mechanicId === null, dSparse.body?.data?.mechanicId);

  const d404 = await get('/api/appointments/APT-8888');
  t('unknown id -> 404', d404.status === 404, d404.status);
  t('404 message names an appointment',
    d404.body?.error?.message === 'No appointment with that id.', d404.body?.error?.message);
  // Every id this appointment actually references is well-formed but elsewhere.
  for (const other of ['CUS-9001','VEH-9001','SRV-9001','MEC-9001','JOB-9001','PRT-9001']) {
    const x = await get('/api/appointments/' + other);
    t(`${other} on the appointments route -> 404, not 400`, x.status === 404, x.status);
  }
  const aOnPart = await get('/api/parts/APT-9001');
  t('appointment id on the parts route -> 404',
    aOnPart.status === 404 && aOnPart.body?.error?.message === 'No part with that id.');

  for (const [id, why] of [['nonsense','no prefix shape'], ['APT-','no number'], ['-9001','no prefix'],
                           ['APPOINTMENT-9001','prefix too long'], ['A-1','prefix too short']]) {
    const bad = await get('/api/appointments/' + encodeURIComponent(id));
    t(`${why} -> 400`, bad.status === 400 && bad.body?.error?.code === 'invalid_id', { id, status: bad.status });
  }
  const dEmpty = await get('/api/appointments/');
  t('trailing slash -> 400', dEmpty.status === 400 && dEmpty.body?.error?.code === 'invalid_id');
  const dEsc = await fetch(BASE + '/api/appointments/%zz');
  t('malformed percent-escape -> 400', dEsc.status === 400, dEsc.status);

  // An injection that would rewrite a source, and one that would cancel
  // everything, with the data re-read afterwards to prove neither landed.
  const injSource = await get('/api/appointments/' + encodeURIComponent("APT-9004'; UPDATE appointments SET source='Website' --"));
  t('source-rewriting injection rejected -> 400', injSource.status === 400, injSource.status);
  const injStatus = await get('/api/appointments/' + encodeURIComponent("APT-9001'; UPDATE appointments SET status='Cancelled' --"));
  t('status-rewriting injection rejected -> 400', injStatus.status === 400, injStatus.status);
  const after = await get('/api/appointments');
  t('Facebook source survived the injection attempt',
    after.body.data.find(a => a.id === 'APT-9004')?.source === 'Facebook');
  t('statuses survived the injection attempt',
    after.body.data.filter(a => a.status === 'Cancelled').length === 1,
    after.body.data.map(a => a.status));
  t('appointments table intact after injection attempts', after.body?.total === 6, after.body?.total);

  for (const m of ['POST','PUT','DELETE','PATCH']) {
    const rl = await get('/api/appointments', { method: m });
    t(`${m} list -> 405 + Allow`, rl.status === 405 && rl.allow === 'GET', { status: rl.status, allow: rl.allow });
    const rd = await get('/api/appointments/APT-9002', { method: m });
    t(`${m} detail -> 405 + Allow`, rd.status === 405 && rd.allow === 'GET', { status: rd.status, allow: rd.allow });
  }

  // The appointment's job card link is an id; the job card itself is a
  // separate collection and is not embedded here.
  t('the job card link stays an id, with no job card object embedded',
    !Object.keys(linked).some(k => /^jobCard($|[A-Z])/.test(k) && k !== 'jobCardId'),
    Object.keys(linked));
}

sec('10e. GET /api/job-cards — parent plus child lines, snapshots preserved');
{
  const r = await get('/api/job-cards');
  t('200', r.status === 200, r.status);
  t('count 4', r.body?.count === 4, r.body?.count);
  t('total 4', r.body?.total === 4, r.body?.total);
  t('meta keys match the other collections',
    JSON.stringify(Object.keys(r.body).sort()) === JSON.stringify(['count','data','limit','offset','total']),
    Object.keys(r.body));
  t('newest first by created_at',
    JSON.stringify(r.body.data.map(j => j.id)) === JSON.stringify(['JOB-9001','JOB-9002','JOB-9003','JOB-9004']),
    r.body.data.map(j => j.id));

  const byId = Object.fromEntries(r.body.data.map(j => [j.id, j]));
  const full = byId['JOB-9001'];

  // ---- parent mapping ----
  t('camelCase keys only', Object.keys(full).every(k => !k.includes('_')), Object.keys(full));
  t('references are ids',
    full.customerId === 'CUS-9002' && full.vehicleId === 'VEH-9002'
      && full.mechanicId === 'MEC-9001' && full.appointmentId === 'APT-9004'
      && full.invoiceId === 'INV-9001',
    { c: full.customerId, v: full.vehicleId, m: full.mechanicId, a: full.appointmentId, i: full.invoiceId });
  t('date is stored text, not shifted', full.date === '2026-09-23', full.date);
  t('estDelivery / actualDelivery preserved',
    full.estDelivery === '2026-09-24' && full.actualDelivery === '2026-09-24');
  t('completedAt preserved', full.completedAt === '2026-09-24T16:00:00', full.completedAt);
  t('status and priority preserved', full.status === 'Delivered' && full.priority === 'high');
  t('mileage and mileageOut', full.mileage === 48200 && full.mileageOut === 48260);
  t('fuelLevel', full.fuelLevel === 'half', full.fuelLevel);
  t('prose fields mapped',
    full.technicianNotes === 'Oil, filter and pads replaced'
      && full.conditionNotes === 'Minor scratch on rear bumper'
      && full.recommendations === 'Air filter at next service');
  t('labourHours / labourRate / labourCost',
    full.labourHours === 1.5 && full.labourRate === 400 && full.labourCost === 600);
  t('updatedAt present when set', full.updatedAt === '2026-09-14T11:00:00', full.updatedAt);

  const sparse = byId['JOB-9002'];
  t('NULL references -> null', sparse.appointmentId === null && sparse.invoiceId === null);
  t('NULL mileage -> null, not 0', sparse.mileage === null, sparse.mileage);
  t('NULL labourHours/labourRate -> null', sparse.labourHours === null && sparse.labourRate === null);
  t('NULL prose -> ""',
    sparse.inspection === '' && sparse.diagnosis === '' && sparse.notes === ''
      && sparse.estDelivery === '' && sparse.completedAt === '' && sparse.fuelLevel === '');
  t('NOT NULL money 0 stays 0',
    sparse.subtotal === 0 && sparse.total === 0 && sparse.paid === 0 && sparse.due === 0);
  t('sparse job card omits updatedAt', !('updatedAt' in sparse), Object.keys(sparse));

  const manualJob = byId['JOB-9003'];
  t('mileage 0 stays 0 — a real reading, unlike JOB-9002 NULL',
    manualJob.mileage === 0 && sparse.mileage === null,
    { zero: manualJob.mileage, absent: sparse.mileage });
  t('0 and null are distinguishable over the wire', manualJob.mileage !== sparse.mileage);

  // ---- child lines ----
  t('full job card has 2 service lines', full.services.length === 2, full.services.length);
  t('full job card has 1 part line', full.partsUsed.length === 1, full.partsUsed.length);
  t('service line shape',
    JSON.stringify(Object.keys(full.services[0]).sort()) ===
      JSON.stringify(['name','qty','serviceId','total','unitPrice']), Object.keys(full.services[0]));
  t('part line shape',
    JSON.stringify(Object.keys(full.partsUsed[0]).sort()) ===
      JSON.stringify(['name','partId','partNo','qty','total','unitPrice']), Object.keys(full.partsUsed[0]));
  t('child rows expose no surrogate id, line_no or jobCardId',
    !['id','lineNo','line_no','jobCardId','job_card_id'].some(k => k in full.services[0]),
    Object.keys(full.services[0]));
  t('service lines in line_no order',
    JSON.stringify(full.services.map(s => s.name)) ===
      JSON.stringify(['Legacy Full Service (2024 price)','Brake Pad Replacement']),
    full.services.map(s => s.name));

  t('a job card with no lines gets services []',
    Array.isArray(sparse.services) && sparse.services.length === 0, sparse.services);
  t('a job card with no lines gets partsUsed []',
    Array.isArray(sparse.partsUsed) && sparse.partsUsed.length === 0, sparse.partsUsed);
  t('lines are attached to the right parents',
    full.services.length === 2 && manualJob.services.length === 0
      && byId['JOB-9004'].services.length === 2,
    { j1: full.services.length, j3: manualJob.services.length, j4: byId['JOB-9004'].services.length });

  // JOB-9004's two service lines share line_no = 1; the id tie-break must keep
  // their order stable across repeated requests.
  const dup = byId['JOB-9004'];
  t('duplicate line_no still yields 2 lines', dup.services.length === 2, dup.services.length);
  const again = await get('/api/job-cards/JOB-9004');
  t('duplicate line_no ordering is stable across requests',
    JSON.stringify(again.body.data.services.map(s => s.name)) === JSON.stringify(dup.services.map(s => s.name)),
    { first: dup.services.map(s => s.name), second: again.body.data.services.map(s => s.name) });

  // ---- historical snapshots ----
  const cat = await get('/api/services/SRV-9001');
  t('the catalogue currently says something different',
    cat.body.data.name === 'B4 Full Service' && cat.body.data.price === 7500,
    { name: cat.body.data.name, price: cat.body.data.price });
  t('the job card still reports the snapshot name',
    full.services[0].name === 'Legacy Full Service (2024 price)', full.services[0].name);
  t('the job card still reports the snapshot price',
    full.services[0].unitPrice === 4000, full.services[0].unitPrice);
  t('serviceId still points at the catalogue row', full.services[0].serviceId === 'SRV-9001');

  const catPart = await get('/api/parts/PRT-9001');
  t('the parts catalogue currently says something different',
    catPart.body.data.name === 'B6 Full Part' && catPart.body.data.partNo === 'B6-OF-001',
    { name: catPart.body.data.name, partNo: catPart.body.data.partNo });
  t('the job card still reports the snapshot part name',
    full.partsUsed[0].name === 'Legacy Oil Filter (2024 label)', full.partsUsed[0].name);
  t('the job card still reports the snapshot part number',
    full.partsUsed[0].partNo === 'LEGACY-OF-001', full.partsUsed[0].partNo);
  t('the job card still reports the snapshot part price',
    full.partsUsed[0].unitPrice === 600, full.partsUsed[0].unitPrice);

  // ---- manual part ----
  t('manual line has partId null', manualJob.partsUsed[0].partId === null, manualJob.partsUsed[0].partId);
  t('manual line keeps its name',
    manualJob.partsUsed[0].name === 'Custom heat shield bracket (hand cut)', manualJob.partsUsed[0].name);
  t('manual line keeps its part number', manualJob.partsUsed[0].partNo === 'MANUAL-01');
  t('manual line keeps its price and total',
    manualJob.partsUsed[0].unitPrice === 150 && manualJob.partsUsed[0].total === 300);
  t('manual line is not promoted into an inventory part',
    manualJob.partsUsed[0].partId !== '' && manualJob.partsUsed[0].partId === null);

  // ---- financial values as stored ----
  t('subtotal/tax/total as stored',
    full.subtotal === 8000 && full.tax === 395 && full.total === 8295,
    { s: full.subtotal, t: full.tax, tot: full.total });
  t('discount and taxRate as stored', full.discount === 100 && full.taxRate === 5);
  t('paid and due as stored', full.paid === 8295 && full.due === 0);
  // The line totals sum to 8000 here, but nothing was recomputed: JOB-9004
  // stores a subtotal of 2400 while its lines sum to 2400 and its total is
  // 2400 with paid 0 — all read back exactly.
  t('a cancelled job card keeps its stored figures',
    dup.subtotal === 2400 && dup.total === 2400 && dup.paid === 0 && dup.due === 0,
    { s: dup.subtotal, t: dup.total, p: dup.paid, d: dup.due });
  t('no live balance field invented',
    !Object.keys(full).some(k => /^live|balance/i.test(k)), Object.keys(full));
  t('paid/due are the job card snapshot, not the invoice-derived live balance',
    full.paid === 8295 && full.due === 0);

  // ---- inspectionChecklist ----
  t('valid JSON checklist is a parsed object',
    typeof full.inspectionChecklist === 'object' && full.inspectionChecklist.brakes === 'worn',
    full.inspectionChecklist);
  t('checklist keys survive',
    JSON.stringify(Object.keys(full.inspectionChecklist).sort()) === JSON.stringify(['battery','brakes','tyres']),
    Object.keys(full.inspectionChecklist));
  t('NULL checklist -> {}',
    JSON.stringify(sparse.inspectionChecklist) === '{}', sparse.inspectionChecklist);
  t('stored empty object stays {}',
    JSON.stringify(manualJob.inspectionChecklist) === '{}', manualJob.inspectionChecklist);
  t('malformed JSON checklist -> {}, not a 500',
    JSON.stringify(dup.inspectionChecklist) === '{}', dup.inspectionChecklist);
  t('the malformed row did not fail the whole list', r.status === 200 && r.body.count === 4);
  const dupDetail = await get('/api/job-cards/JOB-9004');
  t('malformed JSON checklist -> 200 on detail too', dupDetail.status === 200, dupDetail.status);
  t('and {} there as well', JSON.stringify(dupDetail.body.data.inspectionChecklist) === '{}');

  // ---- relationships are not embedded ----
  const keys = new Set(r.body.data.flatMap(j => Object.keys(j)));
  t('no customer/vehicle/mechanic object embedded',
    !['customer','customerName','vehicle','vehicleRegNo','mechanic','mechanicName'].some(k => keys.has(k)),
    [...keys]);
  t('no appointment or invoice object embedded',
    !['appointment','invoice','invoiceStatus','invoiceTotal'].some(k => keys.has(k)), [...keys]);
  t('no inventory field embedded',
    !['stock','issuedQty','currentStock'].some(k => keys.has(k)), [...keys]);

  // ---- pagination ----
  const p1 = await get('/api/job-cards?limit=2');
  t('limit=2 returns 2', p1.body?.data?.length === 2, p1.body?.data?.length);
  t('total still 4', p1.body?.total === 4, p1.body?.total);
  t('a paged result still carries its child lines',
    p1.body.data.find(j => j.id === 'JOB-9001').services.length === 2);
  const p2 = await get('/api/job-cards?limit=2&offset=2');
  t('offset=2 returns the next page',
    JSON.stringify(p2.body.data.map(j => j.id)) === JSON.stringify(['JOB-9003','JOB-9004']),
    p2.body.data.map(j => j.id));
  t('pages do not overlap', !p2.body.data.some(j => p1.body.data.find(x => x.id === j.id)));
  const p3 = await get('/api/job-cards?offset=99');
  t('offset past end -> empty array, still 200', p3.status === 200 && p3.body.data.length === 0);
  // The SQLite variable ceiling: a full-size page must work against a real D1.
  const p4 = await get('/api/job-cards?limit=1000');
  t('limit=1000 succeeds against real D1 — no variable-limit failure',
    p4.status === 200, { status: p4.status, err: p4.body?.error });
  t('and returns every job card', p4.body?.count === 4, p4.body?.count);
  for (const [q, why] of [['limit=0','limit below min'], ['limit=1001','limit above max'],
                          ['limit=abc','limit not a number'], ['offset=-1','offset negative']]) {
    const bad = await get('/api/job-cards?' + q);
    t(`${why} -> 400`, bad.status === 400 && bad.body?.error?.code === 'invalid_parameter', { q, status: bad.status });
  }

  // ---- detail ----
  const d = await get('/api/job-cards/JOB-9001');
  t('detail 200', d.status === 200, d.status);
  t('detail matches the list record', JSON.stringify(d.body.data) === JSON.stringify(full));
  t('no list meta on detail', d.body.count === undefined && d.body.limit === undefined);
  const dEmpty = await get('/api/job-cards/JOB-9002');
  t('a line-less job card still returns both empty arrays',
    dEmpty.body.data.services.length === 0 && dEmpty.body.data.partsUsed.length === 0);

  const d404 = await get('/api/job-cards/JOB-8888');
  t('unknown id -> 404', d404.status === 404, d404.status);
  t('404 message names a job card',
    d404.body?.error?.message === 'No job card with that id.', d404.body?.error?.message);
  for (const other of ['CUS-9001','VEH-9001','APT-9001','SRV-9001','MEC-9001','PRT-9001','INV-9001']) {
    const x = await get('/api/job-cards/' + other);
    t(`${other} on the job-cards route -> 404, not 400`, x.status === 404, x.status);
  }
  const jOnAppt = await get('/api/appointments/JOB-9001');
  t('job card id on the appointments route -> 404',
    jOnAppt.status === 404 && jOnAppt.body?.error?.message === 'No appointment with that id.');

  for (const [id, why] of [['nonsense','no prefix shape'], ['JOB-','no number'], ['-9001','no prefix'],
                           ['JOBCARDS-9001','prefix too long'], ['J-1','prefix too short']]) {
    const bad = await get('/api/job-cards/' + encodeURIComponent(id));
    t(`${why} -> 400`, bad.status === 400 && bad.body?.error?.code === 'invalid_id', { id, status: bad.status });
  }
  const dSlash = await get('/api/job-cards/');
  t('trailing slash -> 400', dSlash.status === 400 && dSlash.body?.error?.code === 'invalid_id');
  const dEsc = await fetch(BASE + '/api/job-cards/%zz');
  t('malformed percent-escape -> 400', dEsc.status === 400, dEsc.status);

  // Injections that would zero the money or delete the lines if they landed.
  const injMoney = await get('/api/job-cards/' + encodeURIComponent("JOB-9001'; UPDATE job_cards SET paid=0, due=0 --"));
  t('money-rewriting injection rejected -> 400', injMoney.status === 400, injMoney.status);
  const injLines = await get('/api/job-cards/' + encodeURIComponent("JOB-9001'; DELETE FROM job_card_parts --"));
  t('line-deleting injection rejected -> 400', injLines.status === 400, injLines.status);
  const after = await get('/api/job-cards/JOB-9001');
  t('money survived the injection attempts',
    after.body?.data?.paid === 8295 && after.body?.data?.due === 0,
    { paid: after.body?.data?.paid, due: after.body?.data?.due });
  t('child lines survived the injection attempts',
    after.body?.data?.partsUsed?.length === 1 && after.body?.data?.services?.length === 2);
  const allAfter = await get('/api/job-cards');
  t('job_cards table intact after injection attempts', allAfter.body?.total === 4, allAfter.body?.total);

  for (const m of ['POST','PUT','DELETE','PATCH']) {
    const rl = await get('/api/job-cards', { method: m });
    t(`${m} list -> 405 + Allow`, rl.status === 405 && rl.allow === 'GET', { status: rl.status, allow: rl.allow });
    const rd = await get('/api/job-cards/JOB-9001', { method: m });
    t(`${m} detail -> 405 + Allow`, rd.status === 405 && rd.allow === 'GET', { status: rd.status, allow: rd.allow });
  }

  // Neither an Invoice nor a Payments API ships in this phase. The names are
  // derived from what health advertises so a later phase that does ship them
  // does not have to come back and edit this.
  const live = (await get('/api/health')).body?.data?.routes ?? [];
  const notYet = ['invoices', 'payments', 'inventory-transactions', 'expenses']
    .filter(name => !live.includes(`GET /api/${name}`));
  t('at least one unshipped collection was found to probe', notYet.length > 0, live);
  for (const name of notYet) {
    const x = await get(`/api/${name}`);
    t(`/api/${name} is not a route yet -> 404`, x.status === 404, x.status);
  }
}

sec('11. Collections stay separate over the wire');
{
  const [s, c, v, m, p, a, j] = await Promise.all([
    get('/api/services'), get('/api/customers'), get('/api/vehicles'),
    get('/api/mechanics'), get('/api/parts'), get('/api/appointments'), get('/api/job-cards')]);
  t('services returns only SRV ids', s.body.data.every(x => x.id.startsWith('SRV-')));
  t('customers returns only CUS ids', c.body.data.every(x => x.id.startsWith('CUS-')));
  t('vehicles returns only VEH ids', v.body.data.every(x => x.id.startsWith('VEH-')));
  t('services rows have no customer fields', !s.body.data.some(x => 'phone' in x || 'regNo' in x));
  t('customers rows have no service fields', !c.body.data.some(x => 'price' in x || 'estTime' in x));
  t('vehicles rows have no service fields', !v.body.data.some(x => 'price' in x || 'estTime' in x));
  t('mechanics returns only MEC ids', m.body.data.every(x => x.id.startsWith('MEC-')));
  t('mechanics rows have no vehicle or service fields',
    !m.body.data.some(x => 'regNo' in x || 'price' in x || 'estTime' in x));
  t('parts returns only PRT ids', p.body.data.every(x => x.id.startsWith('PRT-')));
  t('stock never appears outside parts',
    ![...s.body.data, ...c.body.data, ...v.body.data, ...m.body.data].some(x => 'stock' in x));
  t('parts rows carry no salary or service fields',
    !p.body.data.some(x => 'salary' in x || 'estTime' in x));
  t('appointments returns only APT ids', a.body.data.every(x => x.id.startsWith('APT-')));
  t('no other collection carries a source or reminderSent',
    ![...s.body.data, ...c.body.data, ...v.body.data, ...m.body.data, ...p.body.data]
      .some(x => 'source' in x || 'reminderSent' in x));
  t('appointments rows carry no stock or salary',
    !a.body.data.some(x => 'stock' in x || 'salary' in x));
  t('job cards returns only JOB ids', j.body.data.every(x => x.id.startsWith('JOB-')));
  t('only job cards carry child line arrays',
    ![...s.body.data, ...c.body.data, ...v.body.data, ...m.body.data, ...p.body.data, ...a.body.data]
      .some(x => 'services' in x || 'partsUsed' in x));
  t('job card rows carry no stock or salary',
    !j.body.data.some(x => 'stock' in x || 'salary' in x));
  t('salary never appears outside mechanics',
    ![...s.body.data, ...c.body.data, ...v.body.data].some(x => 'salary' in x || 'commissionRate' in x));
}

sec('12. Unknown routes');
{
  // Pick a collection the router does NOT know, derived from what health
  // advertises rather than hardcoded. B-4 hardcoded /api/mechanics here and
  // B-5 turned it into a real route, so the assertion started failing for the
  // wrong reason. Deriving it means the next phase inherits this unchanged.
  const advertised = (await get('/api/health')).body?.data?.routes ?? [];
  const unregistered = ['parts', 'invoices', 'payments', 'expenses', 'widgets']
    .find(name => !advertised.includes(`GET /api/${name}`));
  t('a collection to probe was found', Boolean(unregistered), advertised);

  const r = await get(`/api/${unregistered}`);
  t(`unregistered collection /api/${unregistered} -> 404`, r.status === 404, r.status);
  t('404 advertises exactly what health advertises',
    JSON.stringify(r.body?.error?.available) === JSON.stringify(advertised),
    { from404: r.body?.error?.available, fromHealth: advertised });
  t('every advertised route is a GET', advertised.every(x => x.startsWith('GET ')), advertised);

  const r2 = await get('/api/services/extra/segments');
  t('deep path under services -> 400 or 404, never 500', r2.status === 400 || r2.status === 404, r2.status);
  const r3 = await get('/nope');
  t('non-api path -> 404', r3.status === 404);
}

console.log(`\nAPI integration: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
