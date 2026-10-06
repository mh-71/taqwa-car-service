/* ============================================================
   vehicles.js — Vehicle Management module
   Vehicles link to customers via customerId (never by name).
   All persistence goes through the Storage layer.
   Field conventions follow existing data: regNo, vin, engineNo,
   mileage, fuelType — plus chassisNo, transmission, status,
   nextServiceDate added by this module (defaults handled).
   ============================================================ */

(() => {

  const { esc, money, fmtDate, badge, toast, Modal } = Utils;

  let searchTerm = '';
  let fBrand = 'all', fFuel = 'all', fService = 'all', fStatus = 'all';
  let sortBy = 'added-desc';

  const FUEL_TYPES = ['Petrol', 'Octane', 'Diesel', 'Hybrid', 'CNG', 'LPG', 'Hybrid + LPG', 'CNG + Octane', 'LPG + Octane', 'Electric'];
  const TRANSMISSIONS = ['Manual', 'Automatic', 'CVT', 'AMT', 'Other'];
  const VEHICLE_BRANDS = [
    'Toyota', 'Honda', 'Nissan', 'Mitsubishi', 'Suzuki', 'Mazda', 'Subaru', 'Daihatsu', 'Isuzu', 'Lexus',
    'Infiniti', 'Hyundai', 'Kia', 'Genesis', 'SsangYong', 'BMW', 'Mercedes-Benz', 'Audi', 'Volkswagen',
    'Porsche', 'Land Rover', 'Jaguar', 'Volvo', 'Skoda', 'Ford', 'Chevrolet', 'Jeep', 'GMC', 'Cadillac',
    'Tesla', 'BYD', 'Chery', 'Geely', 'Haval', 'GWM', 'BAIC', 'JAC', 'Jetour', 'Changan', 'DFSK', 'Foton',
    'MG', 'Deepal', 'Jaecoo', 'Omoda', 'Tata', 'Mahindra', 'Ashok Leyland', 'Maruti Suzuki', 'Renault',
    'Peugeot', 'Citroën', 'Proton', 'Fiat'
  ];
  /* Brand -> common models (Bangladesh new/reconditioned market). Suggestions
     only: the model field still accepts any text, so a missing or uncommon
     model can always be typed. */
  const VEHICLE_MODELS = {
    'Toyota': ['Corolla', 'Corolla Axio', 'Corolla Fielder', 'Corolla Cross', 'Allion', 'Premio', 'Camry', 'Crown', 'Mark X',
      'Aqua', 'Prius', 'Yaris', 'Vitz', 'Belta', 'Passo', 'C-HR', 'Raize', 'Rush', 'Harrier', 'RAV4', 'Fortuner',
      'Land Cruiser', 'Land Cruiser Prado', 'Hilux', 'Noah', 'Voxy', 'Esquire', 'Sienta', 'Wish', 'Estima',
      'Alphard', 'Vellfire', 'Hiace', 'Probox', 'Succeed', 'Townace', 'Liteace', 'Avanza', 'Innova'],
    'Honda': ['Civic', 'City', 'Accord', 'Fit', 'Grace', 'Insight', 'Vezel', 'HR-V', 'CR-V', 'WR-V', 'BR-V', 'Freed',
      'Shuttle', 'Jade', 'Stepwgn', 'Odyssey', 'Pilot'],
    'Nissan': ['Sunny', 'Sylphy', 'Bluebird Sylphy', 'Tiida', 'Note', 'Almera', 'Teana', 'Leaf', 'Wingroad', 'AD Van',
      'Juke', 'Kicks', 'Qashqai', 'X-Trail', 'Murano', 'Pathfinder', 'Patrol', 'Navara', 'Serena', 'Elgrand',
      'Caravan', 'Urvan'],
    'Mitsubishi': ['Mirage', 'Attrage', 'Lancer', 'ASX', 'RVR', 'Eclipse Cross', 'Outlander', 'Pajero', 'Pajero Sport',
      'Xpander', 'Delica', 'L200', 'Triton'],
    'Suzuki': ['Alto', 'Wagon R', 'Celerio', 'Swift', 'Dzire', 'Baleno', 'Ciaz', 'Ertiga', 'XL7', 'Vitara',
      'Grand Vitara', 'S-Cross', 'Jimny', 'Every', 'Carry', 'APV'],
    'Mazda': ['Mazda2', 'Demio', 'Mazda3', 'Axela', 'Mazda6', 'Atenza', 'CX-3', 'CX-30', 'CX-5', 'CX-8', 'CX-9',
      'BT-50', 'Bongo'],
    'Subaru': ['Impreza', 'XV', 'Forester', 'Outback', 'Legacy', 'Levorg', 'WRX'],
    'Daihatsu': ['Mira', 'Move', 'Tanto', 'Boon', 'Rocky', 'Terios', 'Xenia', 'Gran Max', 'Hijet'],
    'Isuzu': ['D-Max', 'MU-X', 'Trooper', 'Elf', 'NKR', 'NPR'],
    'Lexus': ['CT', 'IS', 'ES', 'GS', 'LS', 'RC', 'UX', 'NX', 'RX', 'GX', 'LX'],
    'Infiniti': ['Q50', 'Q60', 'QX50', 'QX60', 'QX80'],
    'Hyundai': ['i10', 'Grand i10', 'i20', 'Accent', 'Elantra', 'Sonata', 'Venue', 'Creta', 'Kona', 'Tucson',
      'Santa Fe', 'Palisade', 'Ioniq 5', 'H-1', 'Starex'],
    'Kia': ['Picanto', 'Rio', 'Cerato', 'K5', 'Optima', 'Soul', 'Sonet', 'Seltos', 'Sportage', 'Sorento', 'Carens',
      'Carnival', 'EV6'],
    'Genesis': ['G70', 'G80', 'G90', 'GV70', 'GV80'],
    'SsangYong': ['Tivoli', 'Korando', 'Rexton', 'Musso'],
    'BMW': ['1 Series', '3 Series', '5 Series', '7 Series', 'X1', 'X3', 'X5', 'X6', 'X7', 'i4', 'iX'],
    'Mercedes-Benz': ['A-Class', 'C-Class', 'E-Class', 'S-Class', 'CLA', 'GLA', 'GLC', 'GLE', 'GLS', 'G-Class',
      'EQS', 'Sprinter'],
    'Audi': ['A3', 'A4', 'A6', 'A8', 'Q3', 'Q5', 'Q7', 'Q8', 'e-tron'],
    'Volkswagen': ['Polo', 'Vento', 'Golf', 'Jetta', 'Passat', 'Tiguan', 'Touareg', 'Transporter'],
    'Porsche': ['911', 'Macan', 'Cayenne', 'Panamera', 'Taycan'],
    'Land Rover': ['Range Rover', 'Range Rover Sport', 'Range Rover Velar', 'Range Rover Evoque', 'Discovery',
      'Discovery Sport', 'Defender', 'Freelander'],
    'Jaguar': ['XE', 'XF', 'XJ', 'E-Pace', 'F-Pace', 'F-Type'],
    'Volvo': ['S60', 'S90', 'V40', 'XC40', 'XC60', 'XC90'],
    'Skoda': ['Fabia', 'Rapid', 'Octavia', 'Superb', 'Kushaq', 'Kodiaq'],
    'Ford': ['Fiesta', 'Focus', 'EcoSport', 'Everest', 'Explorer', 'Ranger', 'F-150', 'Mustang', 'Transit'],
    'Chevrolet': ['Spark', 'Beat', 'Aveo', 'Optra', 'Cruze', 'Malibu', 'Captiva', 'Trailblazer', 'Tahoe'],
    'Jeep': ['Renegade', 'Compass', 'Cherokee', 'Grand Cherokee', 'Wrangler'],
    'GMC': ['Terrain', 'Acadia', 'Yukon', 'Sierra'],
    'Cadillac': ['CT5', 'XT4', 'XT5', 'Escalade'],
    'Tesla': ['Model 3', 'Model S', 'Model X', 'Model Y'],
    'BYD': ['Seagull', 'Dolphin', 'Atto 3', 'Seal', 'Sealion 7', 'Song Plus', 'Han', 'Tang', 'e6'],
    'Chery': ['QQ', 'Arrizo 5', 'Tiggo 2', 'Tiggo 4 Pro', 'Tiggo 7 Pro', 'Tiggo 8 Pro'],
    'Geely': ['Emgrand', 'Geometry C', 'Coolray', 'Azkarra', 'Okavango', 'Monjaro'],
    'Haval': ['H2', 'Jolion', 'H6', 'Dargo', 'H9'],
    'GWM': ['Ora Good Cat', 'Wingle', 'Poer', 'Tank 300', 'Tank 500'],
    'BAIC': ['D20', 'X25', 'X35', 'X55', 'BJ40'],
    'JAC': ['JS2', 'JS4', 'J7', 'T6', 'T8', 'Sunray'],
    'Jetour': ['Dashing', 'X70', 'X90', 'T2'],
    'Changan': ['Alsvin', 'CS35 Plus', 'CS55 Plus', 'CS75 Plus', 'Uni-K', 'Uni-T', 'Hunter'],
    'DFSK': ['Glory 500', 'Glory 580', 'Glory iX5', 'C35', 'K01'],
    'Foton': ['View', 'Gratour', 'Tunland', 'Aumark'],
    'MG': ['MG3', 'MG5', 'MG6', 'ZS', 'ZS EV', 'MG4 EV', 'HS', 'RX5'],
    'Deepal': ['S07', 'L07'],
    'Jaecoo': ['J7', 'J8'],
    'Omoda': ['C5', 'E5'],
    'Tata': ['Tiago', 'Tigor', 'Altroz', 'Punch', 'Nexon', 'Harrier', 'Safari', 'Sumo', 'Xenon', 'Ace'],
    'Mahindra': ['XUV300', 'XUV500', 'XUV700', 'Scorpio', 'Scorpio-N', 'Thar', 'Bolero', 'Pik-Up'],
    'Ashok Leyland': ['Dost', 'Partner', 'Falcon'],
    'Maruti Suzuki': ['Alto', 'Wagon R', 'Celerio', 'Swift', 'Dzire', 'Baleno', 'Brezza', 'Ertiga'],
    'Renault': ['Kwid', 'Triber', 'Duster', 'Captur', 'Megane', 'Koleos'],
    'Peugeot': ['208', '301', '308', '508', '2008', '3008', '5008'],
    'Citroën': ['C3', 'C4', 'C5 Aircross', 'Berlingo'],
    'Proton': ['Saga', 'Persona', 'Iriz', 'Exora', 'X50', 'X70'],
    'Fiat': ['500', 'Punto', 'Linea', 'Tipo', 'Doblo']
  };

  /* ============================================================
     Derived vehicle stats (from real job cards / invoices only)
     ============================================================ */

  function vehicleStats(vehicleId) {
    const jobs = Storage.getData('jobCards').filter(j => j.vehicleId === vehicleId);
    const invoices = Storage.getData('invoices').filter(i => i.vehicleId === vehicleId);
    const serviced = jobs
      .filter(j => !['Cancelled'].includes(j.status))
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    return {
      jobs, invoices,
      serviceCount: jobs.length,
      totalSpent: jobs.reduce((s, j) => s + (Number(j.total) || 0), 0),
      // Live balances (Utils.sumJobs*) rather than the Job Cards' frozen
      // pre-invoice snapshot, so a settled invoice clears the vehicle's due.
      totalPaid: Utils.sumJobsPaid(jobs),
      totalDue: Utils.sumJobsDue(jobs),
      lastServiceDate: serviced.length ? serviced[0].date : null
    };
  }

  function serviceStatus(v, st) {
    const today = Utils.todayStr();
    if (v.nextServiceDate) {
      return v.nextServiceDate < today ? 'due' : 'upcoming';
    }
    return st.serviceCount ? 'upcoming' : 'none';
  }

  /* ============================================================
     List: filter, sort, render
     ============================================================ */

  function filteredVehicles() {
    const term = searchTerm.trim().toLowerCase();

    let list = Storage.getData('vehicles').map(v => {
      const st = vehicleStats(v.id);
      return { v, st, custName: Utils.customerName(v.customerId) };
    });

    list = list.filter(({ v, st, custName }) => {
      if (term) {
        const hay = `${v.regNo} ${v.id} ${custName} ${v.brand} ${v.model} ${v.vin || ''} ${v.chassisNo || ''} ${v.engineNo || ''}`.toLowerCase();
        if (!hay.includes(term)) return false;
      }
      if (fBrand !== 'all' && v.brand !== fBrand) return false;
      if (fFuel !== 'all' && v.fuelType !== fFuel) return false;
      if (fStatus !== 'all' && (v.status || 'Active') !== fStatus) return false;
      if (fService !== 'all' && serviceStatus(v, st) !== fService) return false;
      return true;
    });

    const cmp = {
      'added-desc':  (a, b) => (b.v.createdAt || '').localeCompare(a.v.createdAt || ''),
      'added-asc':   (a, b) => (a.v.createdAt || '').localeCompare(b.v.createdAt || ''),
      'reg':         (a, b) => a.v.regNo.localeCompare(b.v.regNo),
      'customer':    (a, b) => a.custName.localeCompare(b.custName),
      'mileage-desc':(a, b) => (Number(b.v.mileage) || 0) - (Number(a.v.mileage) || 0),
      'last-service':(a, b) => (b.st.lastServiceDate || '').localeCompare(a.st.lastServiceDate || ''),
      'next-service':(a, b) => (a.v.nextServiceDate || '9999').localeCompare(b.v.nextServiceDate || '9999')
    }[sortBy];
    list.sort(cmp);
    return list;
  }

  function populateBrandFilter() {
    const brands = [...new Set(Storage.getData('vehicles').map(v => v.brand).filter(Boolean))].sort();
    const sel = document.getElementById('vehBrand');
    const current = sel.value;
    sel.innerHTML = `<option value="all">All brands</option>` +
      brands.map(b => `<option${b === current ? ' selected' : ''}>${esc(b)}</option>`).join('');
  }

  function renderList() {
    const rows = filteredVehicles();
    const total = Storage.getData('vehicles').length;
    const tbody = document.getElementById('vehTableBody');
    const isFiltered = searchTerm || fBrand !== 'all' || fFuel !== 'all' || fService !== 'all' || fStatus !== 'all';

    document.getElementById('vehCount').textContent =
      isFiltered ? `${rows.length} of ${total} vehicles` : `${total} vehicles`;

    if (!rows.length) {
      tbody.innerHTML = `
        <tr><td colspan="10">
          <div class="empty">
            <svg viewBox="0 0 24 24" width="44" height="44" fill="currentColor"><path d="M18.9 6c-.2-.6-.8-1-1.4-1H6.5c-.6 0-1.2.4-1.4 1L3 12v8c0 .6.4 1 1 1h1c.6 0 1-.4 1-1v-1h12v1c0 .6.4 1 1 1h1c.6 0 1-.4 1-1v-8l-2.1-6zM6.5 15c-.8 0-1.5-.7-1.5-1.5S5.7 12 6.5 12s1.5.7 1.5 1.5S7.3 15 6.5 15zm11 0c-.8 0-1.5-.7-1.5-1.5s.7-1.5 1.5-1.5 1.5.7 1.5 1.5-.7 1.5-1.5 1.5zM5 10l1.5-4.5h11L19 10H5z"/></svg>
            <h3>${isFiltered ? 'No vehicles match your search/filter.' : 'No vehicles found'}</h3>
            <p>${isFiltered ? 'Try different keywords or reset the filters.' : 'Add your first vehicle to get started.'}</p>
            ${isFiltered ? '' : '<button class="btn btn--primary" data-action="add">Add Vehicle</button>'}
          </div>
        </td></tr>`;
      return;
    }

    const today = Utils.todayStr();
    tbody.innerHTML = rows.map(({ v, st }) => {
      const nextTxt = v.nextServiceDate
        ? `<span class="${v.nextServiceDate < today ? 'due' : ''}">${fmtDate(v.nextServiceDate)}</span>`
        : '<span class="muted">—</span>';
      return `
      <tr data-id="${esc(v.id)}">
        <td class="cell-main">${esc(v.id)}</td>
        <td class="cell-main">${esc(v.regNo)}</td>
        <td>${esc(Utils.customerName(v.customerId))}</td>
        <td>${esc(v.brand)} ${esc(v.model)}${v.color ? `<span class="cell-sub">${esc(v.color)} · ${esc(v.fuelType || '')}</span>` : ''}</td>
        <td class="num">${v.year || '—'}</td>
        <td class="num">${v.mileage ? Number(v.mileage).toLocaleString('en-IN') + ' km' : '—'}</td>
        <td>${st.lastServiceDate ? fmtDate(st.lastServiceDate) : '<span class="muted">No service yet</span>'}</td>
        <td>${nextTxt}</td>
        <td>${badge(v.status || 'Active')}</td>
        <td>
          <div class="row-actions">
            <button class="icon-btn icon-btn--sm" data-action="view" title="View details" aria-label="View ${esc(v.regNo)}">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 4.5C7 4.5 2.7 7.6 1 12c1.7 4.4 6 7.5 11 7.5s9.3-3.1 11-7.5c-1.7-4.4-6-7.5-11-7.5zm0 12.5c-2.8 0-5-2.2-5-5s2.2-5 5-5 5 2.2 5 5-2.2 5-5 5zm0-8c-1.7 0-3 1.3-3 3s1.3 3 3 3 3-1.3 3-3-1.3-3-3-3z"/></svg>
            </button>
            <button class="icon-btn icon-btn--sm" data-action="edit" title="Edit" aria-label="Edit ${esc(v.regNo)}">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M3 17.2V21h3.8l11-11.1-3.7-3.7L3 17.2zM20.7 7c.4-.4.4-1 0-1.4l-2.3-2.3c-.4-.4-1-.4-1.4 0l-1.8 1.8 3.7 3.7L20.7 7z"/></svg>
            </button>
            <button class="icon-btn icon-btn--sm icon-btn--danger" data-action="delete" title="Delete" aria-label="Delete ${esc(v.regNo)}">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
            </button>
          </div>
        </td>
      </tr>`;
    }).join('');
  }

  /* ============================================================
     Add / Edit form
     ============================================================ */

  function customerOptions(selectedId = '') {
    const customers = Storage.getData('customers')
      .slice().sort((a, b) => a.name.localeCompare(b.name));
    return `<option value="">— Select customer —</option>` + customers.map(c =>
      `<option value="${esc(c.id)}"${c.id === selectedId ? ' selected' : ''}>${esc(c.name)} — ${esc(c.phone)}</option>`
    ).join('');
  }

  /* Searchable customer picker (Add Vehicle only). The chosen customer's id
     goes into a hidden input named customerId, so readForm, validate and the
     API payload see exactly what the <select> used to give them. */
  const PICKER_LIMIT = 50;
  const digitsOf = s => String(s || '').replace(/\D/g, '');

  function customerPickerHtml(selectedId = '') {
    const c = selectedId ? Storage.getById('customers', selectedId) : null;
    return `
      <div class="cust-picker">
        <div class="cust-picker__box">
          <input class="input" id="vf-customer-search" type="text" autocomplete="off"
                 placeholder="🔍 Search customer by name or phone"
                 role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="vf-customer-list"
                 value="${c ? esc(`${c.name} — ${c.phone}`) : ''}">
          <button type="button" class="cust-picker__clear" aria-label="Clear selected customer"${c ? '' : ' hidden'}>&times;</button>
        </div>
        <input type="hidden" id="vf-customer" name="customerId" value="${c ? esc(c.id) : ''}">
        <ul class="cust-picker__list" id="vf-customer-list" role="listbox" aria-label="Matching customers" hidden></ul>
        <div class="cust-picker__picked muted-note"${c ? '' : ' hidden'}>${c ? `Selected: ${esc(c.id)}` : ''}</div>
      </div>`;
  }

  function matchCustomers(query) {
    const all = Storage.getData('customers')
      .slice().sort((a, b) => a.name.localeCompare(b.name));
    const q = query.trim().toLowerCase();
    if (!q) return all;
    const qDigits = digitsOf(q);
    return all.filter(c =>
      (c.name || '').toLowerCase().includes(q) ||
      (qDigits.length >= 3 && digitsOf(c.phone).includes(qDigits)));
  }

  function bindCustomerPicker(root) {
    const hidden = root.querySelector('#vf-customer');
    const input = root.querySelector('#vf-customer-search');
    const list = root.querySelector('#vf-customer-list');
    const clear = root.querySelector('.cust-picker__clear');
    const picked = root.querySelector('.cust-picker__picked');
    let matches = [];
    let active = -1;

    const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); active = -1; };
    const highlight = i => {
      active = i;
      list.querySelectorAll('[role="option"]').forEach((li, n) => li.classList.toggle('is-active', n === i));
      const li = list.querySelector(`[data-index="${i}"]`);
      if (li) { li.scrollIntoView({ block: 'nearest' }); input.setAttribute('aria-activedescendant', li.id); }
      else input.removeAttribute('aria-activedescendant');
    };
    const render = () => {
      matches = matchCustomers(input.value);
      const shown = matches.slice(0, PICKER_LIMIT);
      list.innerHTML = shown.length
        ? shown.map((c, i) => `
            <li role="option" id="vf-cust-opt-${i}" data-index="${i}" aria-selected="${c.id === hidden.value}">
              <span class="cust-picker__name">${esc(c.name)}</span>
              <span class="cust-picker__meta">${esc(c.phone || '')} · ${esc(c.id)}</span>
            </li>`).join('') +
          (matches.length > PICKER_LIMIT
            ? `<li class="cust-picker__more" aria-hidden="true">Showing ${PICKER_LIMIT} of ${matches.length} — keep typing to narrow down.</li>` : '')
        : `<li class="cust-picker__empty">No customers found</li>`;
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      highlight(shown.length ? 0 : -1);
    };
    const choose = c => {
      hidden.value = c.id;
      input.value = `${c.name} — ${c.phone}`;
      picked.textContent = `Selected: ${c.id}`;
      picked.hidden = false;
      clear.hidden = false;
      close();
    };
    const unselect = () => {
      hidden.value = '';
      picked.hidden = true;
      clear.hidden = true;
    };

    input.addEventListener('click', () => { if (list.hidden) render(); });
    input.addEventListener('input', () => { unselect(); render(); });
    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (list.hidden) { render(); return; }
        const n = Math.min(matches.length, PICKER_LIMIT);
        if (n) highlight((active + (e.key === 'ArrowDown' ? 1 : -1) + n) % n);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (!list.hidden && active >= 0) choose(matches[active]);
      } else if (e.key === 'Escape' && !list.hidden) {
        e.stopPropagation(); // close the list, not the whole modal
        close();
      }
    });
    // mousedown (not click) so the choice lands before the input's blur closes the list
    list.addEventListener('mousedown', e => {
      const li = e.target.closest('[role="option"]');
      e.preventDefault();
      if (li) choose(matches[Number(li.dataset.index)]);
    });
    input.addEventListener('blur', close);
    clear.addEventListener('click', () => { input.value = ''; unselect(); input.focus(); });
  }

  /* Searchable brand field (Add and Edit). The input itself stays the `brand`
     value, so picking from the list just fills it in; a brand outside the
     list can still be typed, exactly as before. Reuses the customer picker's
     dropdown styles. */
  function matchBrands(query) {
    const q = query.trim().toLowerCase();
    if (!q) return VEHICLE_BRANDS.slice();
    const starts = [], contains = [];
    VEHICLE_BRANDS.forEach(b => {
      const i = b.toLowerCase().indexOf(q);
      if (i === 0) starts.push(b); else if (i > 0) contains.push(b);
    });
    return starts.concat(contains);
  }

  function bindBrandPicker(root) {
    const input = root.querySelector('#vf-brand');
    const list = root.querySelector('#vf-brand-list');
    let matches = [];
    let active = -1;

    const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); active = -1; };
    const highlight = i => {
      active = i;
      list.querySelectorAll('[role="option"]').forEach((li, n) => li.classList.toggle('is-active', n === i));
      const li = list.querySelector(`[data-index="${i}"]`);
      if (li) { li.scrollIntoView({ block: 'nearest' }); input.setAttribute('aria-activedescendant', li.id); }
      else input.removeAttribute('aria-activedescendant');
    };
    const render = () => {
      matches = matchBrands(input.value);
      list.innerHTML = matches.length
        ? matches.map((b, i) => `<li role="option" id="vf-brand-opt-${i}" data-index="${i}" aria-selected="${b === input.value}"><span class="cust-picker__name">${esc(b)}</span></li>`).join('')
        : `<li class="cust-picker__empty">No brands found</li>`;
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      highlight(matches.length && input.value.trim() ? 0 : -1);
    };
    const choose = b => { input.value = b; close(); };

    input.addEventListener('click', () => { if (list.hidden) render(); });
    input.addEventListener('input', render);
    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (list.hidden) { render(); return; }
        if (matches.length) highlight((active + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (!list.hidden && active >= 0) choose(matches[active]);
      } else if (e.key === 'Escape' && !list.hidden) {
        e.stopPropagation(); // close the list, not the whole modal
        close();
      }
    });
    // mousedown (not click) so the choice lands before the input's blur closes the list
    list.addEventListener('mousedown', e => {
      const li = e.target.closest('[role="option"]');
      e.preventDefault();
      if (li) choose(matches[Number(li.dataset.index)]);
    });
    input.addEventListener('blur', close);
  }

  /* Searchable model field (Add and Edit), suggesting the chosen brand's
     models. Like the brand field, the input itself stays the `model` value and
     free text is still accepted. When the brand is changed, a model that does
     not belong to the new brand is cleared; a vehicle loaded for editing keeps
     whatever model it was saved with. */
  const lower = s => String(s || '').trim().toLowerCase();

  function modelsForBrand(brand) {
    const key = Object.keys(VEHICLE_MODELS).find(b => lower(b) === lower(brand));
    return key ? VEHICLE_MODELS[key] : [];
  }

  function matchModels(brand, query) {
    const q = lower(query);
    const all = modelsForBrand(brand);
    if (!q) return all.slice();
    const starts = [], contains = [];
    all.forEach(m => {
      const i = m.toLowerCase().indexOf(q);
      if (i === 0) starts.push(m); else if (i > 0) contains.push(m);
    });
    return starts.concat(contains);
  }

  function bindModelPicker(root) {
    const brandInput = root.querySelector('#vf-brand');
    const input = root.querySelector('#vf-model');
    const list = root.querySelector('#vf-model-list');
    let matches = [];
    let active = -1;
    let lastBrand = lower(brandInput.value);

    const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); active = -1; };
    const highlight = i => {
      active = i;
      list.querySelectorAll('[role="option"]').forEach((li, n) => li.classList.toggle('is-active', n === i));
      const li = list.querySelector(`[data-index="${i}"]`);
      if (li) { li.scrollIntoView({ block: 'nearest' }); input.setAttribute('aria-activedescendant', li.id); }
      else input.removeAttribute('aria-activedescendant');
    };
    const render = () => {
      const brand = brandInput.value.trim();
      matches = brand ? matchModels(brand, input.value) : [];
      list.innerHTML = matches.length
        ? matches.map((m, i) => `<li role="option" id="vf-model-opt-${i}" data-index="${i}" aria-selected="${m === input.value}"><span class="cust-picker__name">${esc(m)}</span></li>`).join('')
        : `<li class="cust-picker__empty">${brand ? 'No models found' : 'Select a brand first'}</li>`;
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      highlight(matches.length && input.value.trim() ? 0 : -1);
    };
    const choose = m => { input.value = m; close(); };

    // Brand committed (typed and left, or picked from its list): drop a model
    // that does not belong to the new brand.
    const brandCommitted = () => {
      const now = lower(brandInput.value);
      if (now === lastBrand) return;
      lastBrand = now;
      const model = lower(input.value);
      if (model && !modelsForBrand(brandInput.value).some(m => lower(m) === model)) input.value = '';
    };
    brandInput.addEventListener('change', brandCommitted);
    brandInput.addEventListener('blur', brandCommitted);

    input.addEventListener('click', () => { if (list.hidden) render(); });
    input.addEventListener('input', render);
    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (list.hidden) { render(); return; }
        if (matches.length) highlight((active + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (!list.hidden && active >= 0) choose(matches[active]);
      } else if (e.key === 'Escape' && !list.hidden) {
        e.stopPropagation(); // close the list, not the whole modal
        close();
      }
    });
    // mousedown (not click) so the choice lands before the input's blur closes the list
    list.addEventListener('mousedown', e => {
      const li = e.target.closest('[role="option"]');
      e.preventDefault();
      if (li) choose(matches[Number(li.dataset.index)]);
    });
    input.addEventListener('blur', close);
  }

  function selectOptions(list, selected) {
    return `<option value="">— Select —</option>` +
      list.map(o => `<option${o === selected ? ' selected' : ''}>${esc(o)}</option>`).join('');
  }

  function formHtml(v = {}, { customerSearch = false } = {}) {
    return `
      <form id="vehForm" novalidate>
        <div class="form-grid">
          <div class="field span-2">
            ${customerSearch
              ? `<label for="vf-customer-search">Customer <span class="req">*</span></label>
            ${customerPickerHtml(v.customerId)}`
              : `<label for="vf-customer">Customer <span class="req">*</span></label>
            <select class="select" id="vf-customer" name="customerId">${customerOptions(v.customerId)}</select>`}
            <div class="field__error" data-err="customerId"></div>
          </div>
          <div class="field">
            <label for="vf-reg">Registration Number <span class="req">*</span></label>
            <input class="input" id="vf-reg" name="regNo" value="${esc(v.regNo || '')}" placeholder="DHAKA-METRO-GA-1234" autocomplete="off">
            <div class="field__error" data-err="regNo"></div>
          </div>
          <div class="field">
            <label for="vf-year">Year</label>
            <input class="input" id="vf-year" name="year" type="number" min="1950" value="${esc(v.year || '')}">
            <div class="field__error" data-err="year"></div>
          </div>
          <div class="field">
            <label for="vf-brand">Brand <span class="req">*</span></label>
            <div class="cust-picker">
              <input class="input" id="vf-brand" name="brand" value="${esc(v.brand || '')}" placeholder="🔍 Search brand" autocomplete="off"
                     role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="vf-brand-list">
              <ul class="cust-picker__list" id="vf-brand-list" role="listbox" aria-label="Matching brands" hidden></ul>
            </div>
            <div class="field__error" data-err="brand"></div>
          </div>
          <div class="field">
            <label for="vf-model">Model <span class="req">*</span></label>
            <div class="cust-picker">
              <input class="input" id="vf-model" name="model" value="${esc(v.model || '')}" placeholder="🔍 Search model" autocomplete="off"
                     role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="vf-model-list">
              <ul class="cust-picker__list" id="vf-model-list" role="listbox" aria-label="Matching models" hidden></ul>
            </div>
            <div class="field__error" data-err="model"></div>
          </div>
          <div class="field">
            <label for="vf-color">Color</label>
            <input class="input" id="vf-color" name="color" value="${esc(v.color || '')}" autocomplete="off">
          </div>
          <div class="field">
            <label for="vf-mileage">Mileage (km)</label>
            <input class="input" id="vf-mileage" name="mileage" type="number" min="0" value="${esc(v.mileage || '')}">
            <div class="field__error" data-err="mileage"></div>
          </div>
          <div class="field">
            <label for="vf-fuel">Fuel Type</label>
            <select class="select" id="vf-fuel" name="fuelType">${selectOptions(FUEL_TYPES, v.fuelType)}</select>
          </div>
          <div class="field">
            <label for="vf-trans">Transmission</label>
            <select class="select" id="vf-trans" name="transmission">${selectOptions(TRANSMISSIONS, v.transmission)}</select>
          </div>
          <div class="field">
            <label for="vf-vin">VIN</label>
            <input class="input" id="vf-vin" name="vin" value="${esc(v.vin || '')}" autocomplete="off">
          </div>
          <div class="field">
            <label for="vf-chassis">Chassis Number</label>
            <input class="input" id="vf-chassis" name="chassisNo" value="${esc(v.chassisNo || '')}" autocomplete="off">
          </div>
          <div class="field">
            <label for="vf-engine">Engine Number</label>
            <input class="input" id="vf-engine" name="engineNo" value="${esc(v.engineNo || '')}" autocomplete="off">
          </div>
          <div class="field">
            <label for="vf-next">Next Service Date</label>
            <input class="input" id="vf-next" name="nextServiceDate" type="date" value="${esc(v.nextServiceDate || '')}">
          </div>
          <div class="field">
            <label for="vf-status">Status</label>
            <select class="select" id="vf-status" name="status">
              <option${(v.status || 'Active') === 'Active' ? ' selected' : ''}>Active</option>
              <option${v.status === 'Inactive' ? ' selected' : ''}>Inactive</option>
            </select>
          </div>
          <div class="field span-2">
            <label for="vf-notes">Notes</label>
            <textarea class="textarea" id="vf-notes" name="notes" rows="2">${esc(v.notes || '')}</textarea>
          </div>
        </div>
      </form>`;
  }

  function readForm(form) {
    const val = n => form[n].value.trim();
    return {
      customerId: val('customerId'), regNo: val('regNo').toUpperCase(),
      brand: val('brand'), model: val('model'),
      year: val('year') ? Number(val('year')) : '',
      color: val('color'),
      mileage: val('mileage') ? Number(val('mileage')) : '',
      fuelType: val('fuelType'), transmission: val('transmission'),
      vin: val('vin'), chassisNo: val('chassisNo'), engineNo: val('engineNo'),
      nextServiceDate: val('nextServiceDate'),
      status: val('status') || 'Active',
      notes: val('notes')
    };
  }

  function validate(values, editingId = null) {
    const errors = {};
    const thisYear = new Date().getFullYear();

    if (!values.customerId) {
      errors.customerId = 'Select the customer who owns this vehicle.';
    } else if (!Storage.getById('customers', values.customerId)) {
      errors.customerId = 'Selected customer no longer exists.';
    }
    if (!values.regNo) {
      errors.regNo = 'Registration number is required.';
    } else {
      const norm = values.regNo.replace(/[\s-]/g, '').toLowerCase();
      const dup = Storage.getData('vehicles').find(v =>
        v.id !== editingId && (v.regNo || '').replace(/[\s-]/g, '').toLowerCase() === norm);
      if (dup) errors.regNo = 'A vehicle with this registration number already exists.';
    }
    if (!values.brand) errors.brand = 'Brand is required.';
    if (!values.model) errors.model = 'Model is required.';
    if (values.year !== '' && (values.year < 1950 || values.year > thisYear + 1))
      errors.year = `Year must be between 1950 and ${thisYear + 1}.`;
    if (values.mileage !== '' && values.mileage < 0)
      errors.mileage = 'Mileage cannot be negative.';

    return { valid: Object.keys(errors).length === 0, errors };
  }

  function showErrors(form, errors) {
    form.querySelectorAll('.field').forEach(f => f.classList.remove('field--error'));
    form.querySelectorAll('[data-err]').forEach(el => el.textContent = '');
    Object.entries(errors).forEach(([key, msg]) => {
      const el = form.querySelector(`[data-err="${key}"]`);
      if (el) { el.textContent = msg; el.closest('.field').classList.add('field--error'); }
    });
  }

  function openAddModal(prefillCustomerId = '') {
    if (!Storage.getData('customers').length) {
      Modal.open({
        title: 'No customers yet',
        body: `<p style="margin:0">Every vehicle must belong to a customer. Add a customer first, then register their vehicle.</p>`,
        footer: `<button class="btn btn--ghost" data-modal-close>Close</button>
                 <a class="btn btn--primary" href="customers.html">Go to Customers</a>`
      });
      return;
    }
    const ov = Modal.open({
      title: 'Add Vehicle', size: 'lg',
      body: formHtml({ customerId: prefillCustomerId }, { customerSearch: true }),
      footer: `<button class="btn btn--ghost" data-modal-close>Cancel</button>
               <button class="btn btn--primary" data-save>Save Vehicle</button>`
    });
    bindCustomerPicker(ov);
    bindBrandPicker(ov);
    bindModelPicker(ov);
    ov.querySelector('[data-save]').addEventListener('click', Utils.saving(async () => {
      const form = ov.querySelector('#vehForm');
      const values = readForm(form);
      const { valid, errors } = validate(values);
      if (!valid) {
        showErrors(form, errors);
        toast(errors.regNo === 'A vehicle with this registration number already exists.'
          ? errors.regNo : 'Please fix the highlighted fields.', 'error');
        return;
      }
      const res = await Storage.create('vehicles', values);
      if (!Utils.wrote(res, form)) return;
      const rec = res.record;
      Modal.close();
      refresh();
      toast(`Vehicle ${rec.regNo} added (${rec.id}).`);
    }));
  }

  function openEditModal(id) {
    const v = Storage.getById('vehicles', id);
    if (!v) return;
    const ov = Modal.open({
      title: `Edit Vehicle — ${v.id}`, size: 'lg',
      body: formHtml(v),
      footer: `<button class="btn btn--ghost" data-modal-close>Cancel</button>
               <button class="btn btn--primary" data-save>Save Changes</button>`
    });
    bindBrandPicker(ov);
    bindModelPicker(ov);
    ov.querySelector('[data-save]').addEventListener('click', Utils.saving(async () => {
      const form = ov.querySelector('#vehForm');
      const values = readForm(form);
      const { valid, errors } = validate(values, id);
      if (!valid) { showErrors(form, errors); toast('Please fix the highlighted fields.', 'error'); return; }
      const res = await Storage.update('vehicles', id, values);
      if (!Utils.wrote(res, form)) return;
      Modal.close();
      refresh();
      toast(`Vehicle ${values.regNo} updated.`);
    }));
  }

  /* ============================================================
     Delete (protect historical records)
     ============================================================ */

  function openDeleteModal(id) {
    const v = Storage.getById('vehicles', id);
    if (!v) return;
    const jobs = Storage.getData('jobCards').filter(j => j.vehicleId === id);
    const invoices = Storage.getData('invoices').filter(i => i.vehicleId === id);
    const appts = Storage.getData('appointments').filter(a => a.vehicleId === id);

    if (jobs.length || invoices.length || appts.length) {
      const parts = [];
      if (jobs.length) parts.push(`${jobs.length} job card${jobs.length > 1 ? 's' : ''}`);
      if (invoices.length) parts.push(`${invoices.length} invoice${invoices.length > 1 ? 's' : ''}`);
      if (appts.length) parts.push(`${appts.length} appointment${appts.length > 1 ? 's' : ''}`);
      Modal.open({
        title: 'Cannot delete vehicle',
        body: `<p style="margin:0"><strong>${esc(v.regNo)}</strong> has ${parts.join(', ')} on record.
               Deleting the vehicle would destroy historical business data.</p>
               <p style="margin:12px 0 0;color:var(--text-2);font-size:.84rem">
               Mark the vehicle inactive instead to hide it from day-to-day use while keeping its history.</p>`,
        footer: `<button class="btn btn--ghost" data-modal-close>Close</button>
                 <button class="btn btn--primary" data-mark-inactive>Mark Inactive</button>`
      }).querySelector('[data-mark-inactive]').addEventListener('click', Utils.saving(async () => {
        const res = await Storage.update('vehicles', id, { status: 'Inactive' });
        if (!Utils.wrote(res)) return;
        Modal.close();
        refresh();
        toast(`Vehicle ${v.regNo} marked inactive.`, 'info');
      }));
      return;
    }

    Modal.confirm({
      title: 'Delete vehicle?',
      message: `Are you sure you want to delete <strong>${esc(v.regNo)}</strong> (${esc(v.brand)} ${esc(v.model)})? This cannot be undone.`,
      confirmText: 'Delete Vehicle',
      onConfirm: async () => {
        const res = await Storage.remove('vehicles', id);
        if (!Utils.wrote(res)) return;
        refresh();
        toast(`Vehicle ${v.regNo} deleted.`, 'warning');
      }
    });
  }

  /* ============================================================
     Details view
     ============================================================ */

  function openDetailModal(id) {
    const v = Storage.getById('vehicles', id);
    if (!v) return;
    const st = vehicleStats(id);
    const owner = Storage.getById('customers', v.customerId);

    const info = [
      ['Vehicle ID', v.id], ['Registration', v.regNo],
      ['Brand', v.brand], ['Model', v.model],
      ['Year', v.year || '—'], ['Color', v.color || '—'],
      ['VIN', v.vin || '—'], ['Chassis No', v.chassisNo || '—'],
      ['Engine No', v.engineNo || '—'],
      ['Mileage', v.mileage ? `${Number(v.mileage).toLocaleString('en-IN')} km` : '—'],
      ['Fuel Type', v.fuelType || '—'], ['Transmission', v.transmission || '—']
    ];

    const jobs = st.jobs.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const historyHtml = jobs.length
      ? `<div class="table-wrap"><table class="table table--compact">
          <thead><tr><th>Job Card</th><th>Date</th><th>Service</th><th>Mechanic</th><th class="num">Mileage</th><th class="num">Amount</th><th>Status</th></tr></thead>
          <tbody>${jobs.map(j => `
            <tr>
              <td class="cell-main">${esc(j.id)}</td>
              <td>${fmtDate(j.date)}</td>
              <td>${esc((j.services || []).map(s => s.name).join(', ') || '—')}</td>
              <td>${esc(Utils.mechanicName(j.mechanicId))}</td>
              <td class="num">${j.mileage ? Number(j.mileage).toLocaleString('en-IN') : '—'}</td>
              <td class="num">${money(j.total)}</td>
              <td>${badge(j.status)}</td>
            </tr>`).join('')}
          </tbody></table></div>`
      : `<p class="muted-note">No service history yet.</p>`;

    const invs = st.invoices.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const invoiceHtml = invs.length
      ? `<div class="table-wrap"><table class="table table--compact">
          <thead><tr><th>Invoice</th><th>Date</th><th>Job Card</th><th class="num">Amount</th><th class="num">Paid</th><th class="num">Due</th><th>Status</th></tr></thead>
          <tbody>${invs.map(i => `
            <tr>
              <td class="cell-main">${esc(i.id)}</td>
              <td>${fmtDate(i.date)}</td>
              <td>${esc(i.jobCardId || '—')}</td>
              <td class="num">${money(i.total)}</td>
              <td class="num">${money(i.paid)}</td>
              <td class="num">${i.due > 0 ? `<span class="due">${money(i.due)}</span>` : money(0)}</td>
              <td>${badge(i.status)}</td>
            </tr>`).join('')}
          </tbody></table></div>`
      : `<p class="muted-note">No invoice history yet.</p>`;

    Modal.open({
      title: `${v.brand} ${v.model} — ${v.regNo}`,
      size: 'lg',
      body: `
        <div class="detail-grid detail-grid--3">
          ${info.map(([k, val]) => `<div class="detail-item"><span>${k}</span><strong>${esc(String(val))}</strong></div>`).join('')}
          <div class="detail-item"><span>Status</span><strong>${badge(v.status || 'Active')}</strong></div>
        </div>

        <h3 class="detail-section-title">Owner</h3>
        ${owner ? `
        <div class="detail-grid">
          <div class="detail-item"><span>Name</span><strong>${esc(owner.name)} (${esc(owner.id)})</strong></div>
          <div class="detail-item"><span>Phone</span><strong>${esc(owner.phone)}</strong></div>
          <div class="detail-item"><span>Email</span><strong>${owner.email ? esc(owner.email) : '—'}</strong></div>
          <div class="detail-item"><span>Address</span><strong>${owner.address ? esc(owner.address) : '—'}</strong></div>
        </div>` : `<p class="muted-note">Owner record not found (${esc(v.customerId || 'none')}).</p>`}

        <div class="summary-row summary-row--6">
          <div class="summary-tile"><strong>${st.serviceCount}</strong><span>Total Services</span></div>
          <div class="summary-tile"><strong>${money(st.totalSpent)}</strong><span>Total Spent</span></div>
          <div class="summary-tile summary-tile--good"><strong>${money(st.totalPaid)}</strong><span>Total Paid</span></div>
          <div class="summary-tile ${st.totalDue > 0 ? 'summary-tile--bad' : ''}"><strong>${money(st.totalDue)}</strong><span>Total Due</span></div>
          <div class="summary-tile"><strong>${st.lastServiceDate ? fmtDate(st.lastServiceDate) : 'No service yet'}</strong><span>Last Service</span></div>
          <div class="summary-tile"><strong>${v.nextServiceDate ? fmtDate(v.nextServiceDate) : '—'}</strong><span>Next Service</span></div>
        </div>

        <h3 class="detail-section-title">Service History</h3>
        ${historyHtml}

        <h3 class="detail-section-title">Invoice History</h3>
        ${invoiceHtml}`,
      footer: `
        ${owner ? `<a class="btn btn--ghost" href="customers.html?view=${encodeURIComponent(owner.id)}">View Customer</a>` : ''}
        <button class="btn btn--ghost" data-modal-close>Close</button>
        <button class="btn btn--primary" data-edit-from-view>Edit Vehicle</button>`
    }).querySelector('[data-edit-from-view]').addEventListener('click', () => {
      Modal.close();
      openEditModal(id);
    });
  }

  /* ============================================================
     Events + init
     ============================================================ */

  function refresh() {
    populateBrandFilter();
    renderList();
  }

  function bindEvents() {
    document.getElementById('addVehicleBtn').addEventListener('click', () => openAddModal());

    document.getElementById('vehSearch').addEventListener('input', e => { searchTerm = e.target.value; renderList(); });
    document.getElementById('vehBrand').addEventListener('change', e => { fBrand = e.target.value; renderList(); });
    document.getElementById('vehFuel').addEventListener('change', e => { fFuel = e.target.value; renderList(); });
    document.getElementById('vehService').addEventListener('change', e => { fService = e.target.value; renderList(); });
    document.getElementById('vehStatus').addEventListener('change', e => { fStatus = e.target.value; renderList(); });
    document.getElementById('vehSort').addEventListener('change', e => { sortBy = e.target.value; renderList(); });

    document.getElementById('vehTableBody').addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === 'add') { openAddModal(); return; }
      const id = btn.closest('tr')?.dataset.id;
      if (!id) return;
      if (action === 'view') openDetailModal(id);
      if (action === 'edit') openEditModal(id);
      if (action === 'delete') openDeleteModal(id);
    });
  }

  Storage.ready(() => {
    bindEvents();
    refresh();
    // Deep link: vehicles.html?view=VEH-0001 opens details directly
    const viewId = new URLSearchParams(location.search).get('view');
    if (viewId && Storage.getById('vehicles', viewId)) openDetailModal(viewId);
  });

})();
