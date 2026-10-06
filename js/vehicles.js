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
  const VEHICLE_COLORS = [
    'Black', 'White', 'Silver', 'Grey', 'Gray', 'Red', 'Blue', 'Dark Blue', 'Light Blue', 'Green', 'Dark Green',
    'Light Green', 'Brown', 'Beige', 'Gold', 'Bronze', 'Orange', 'Yellow', 'Purple', 'Maroon', 'Wine', 'Burgundy',
    'Cream', 'Pearl White', 'Off White', 'Champagne', 'Gunmetal', 'Charcoal'
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

  /* Searchable color field (Add and Edit). Same pattern as the brand field:
     the input stays the `color` value, a color outside the list can still be
     typed, and a saved color is shown as-is. Grey and Gray are treated as one
     spelling when matching, so "gre" also finds Gray. Colors that start with
     the typed text come first; each group keeps list order. */
  const colorKey = s => String(s || '').toLowerCase().replace(/gray/g, 'grey');

  function matchColors(query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return VEHICLE_COLORS.slice();
    const qKey = colorKey(q);
    const starts = [], contains = [];
    VEHICLE_COLORS.forEach(c => {
      const raw = c.toLowerCase(), key = colorKey(c);
      if (raw.startsWith(q) || key.startsWith(qKey)) starts.push(c);
      else if (raw.includes(q) || key.includes(qKey)) contains.push(c);
    });
    return starts.concat(contains);
  }

  function bindColorPicker(root) {
    const input = root.querySelector('#vf-color');
    const list = root.querySelector('#vf-color-list');
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
      matches = matchColors(input.value);
      list.innerHTML = matches.length
        ? matches.map((c, i) => `<li role="option" id="vf-color-opt-${i}" data-index="${i}" aria-selected="${c === input.value}"><span class="cust-picker__name">${esc(c)}</span></li>`).join('')
        : `<li class="cust-picker__empty">No colors found</li>`;
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      highlight(matches.length && input.value.trim() ? 0 : -1);
    };
    const choose = c => { input.value = c; close(); };

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

  /* Section headings for the Add Vehicle form. Icons reuse the sidebar's
     paths so the modal speaks the same visual language as the navigation. */
  const FORM_SECTIONS = [
    { key: 'customer', title: 'Customer Information', desc: 'Who owns this vehicle',
      icon: 'M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z',
      fields: ['customer'] },
    { key: 'ident', title: 'Vehicle Identification', desc: 'Basic details used to identify the vehicle',
      icon: 'M18.9 6c-.2-.6-.8-1-1.4-1H6.5c-.6 0-1.2.4-1.4 1L3 12v8c0 .6.4 1 1 1h1c.6 0 1-.4 1-1v-1h12v1c0 .6.4 1 1 1h1c.6 0 1-.4 1-1v-8l-2.1-6zM6.5 15c-.8 0-1.5-.7-1.5-1.5S5.7 12 6.5 12s1.5.7 1.5 1.5S7.3 15 6.5 15zm11 0c-.8 0-1.5-.7-1.5-1.5s.7-1.5 1.5-1.5 1.5.7 1.5 1.5-.7 1.5-1.5 1.5zM5 10l1.5-4.5h11L19 10H5z',
      fields: ['reg', 'year', 'brand', 'model', 'color', 'mileage'] },
    { key: 'tech', title: 'Technical Details', desc: 'Additional technical information (optional)',
      icon: 'M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1 .1-1.4z',
      fields: ['fuel', 'trans', 'vin', 'chassis', 'engine', 'next'] },
    { key: 'status', title: 'Status & Notes', desc: 'Vehicle status and any additional notes',
      icon: 'M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z',
      fields: ['status', 'notes'] }
  ];

  /* Section headings for the Edit Vehicle form (same fields, ids and order of
     inputs as Add; grouped as the edit reference). `cols: 3` uses the existing
     three-column grid. */
  const EDIT_SECTIONS = [
    { ...FORM_SECTIONS[0], desc: 'Select or change the customer for this vehicle' },
    { key: 'ident', title: 'Vehicle Identification', desc: 'Basic information about the vehicle',
      icon: FORM_SECTIONS[1].icon, fields: ['reg', 'year', 'brand', 'model', 'color'] },
    { key: 'tech', title: 'Technical Details', desc: 'Engine, transmission and other technical information',
      icon: 'M19.1 12.9c0-.3.1-.6.1-.9s0-.6-.1-.9l2-1.6c.2-.1.2-.4.1-.6l-1.9-3.3c-.1-.2-.4-.3-.6-.2l-2.4 1c-.5-.4-1-.7-1.6-.9l-.4-2.5c0-.2-.2-.4-.5-.4h-3.8c-.2 0-.4.2-.5.4l-.4 2.5c-.6.2-1.1.6-1.6.9l-2.4-1c-.2-.1-.5 0-.6.2L2.6 9c-.1.2-.1.4.1.6l2 1.6c0 .3-.1.6-.1.9s0 .6.1.9l-2 1.6c-.2.1-.2.4-.1.6l1.9 3.3c.1.2.4.3.6.2l2.4-1c.5.4 1 .7 1.6.9l.4 2.5c0 .2.2.4.5.4h3.8c.2 0 .4-.2.5-.4l.4-2.5c.6-.2 1.1-.6 1.6-.9l2.4 1c.2.1.5 0 .6-.2l1.9-3.3c.1-.2.1-.4-.1-.6l-2-1.6zM12 15.5c-1.9 0-3.5-1.6-3.5-3.5s1.6-3.5 3.5-3.5 3.5 1.6 3.5 3.5-1.6 3.5-3.5 3.5z',
      fields: ['mileage', 'fuel', 'trans', 'vin', 'chassis', 'engine'], cols: 3 },
    { key: 'service', title: 'Service & Status', desc: 'Service schedule, current status and additional notes',
      icon: FORM_SECTIONS[2].icon, fields: ['next', 'status', 'notes'] }
  ];

  /* Add Vehicle (customerSearch) and Edit Vehicle (EDIT_SECTIONS) group the
     fields into titled sections; with no sections the plain grid is used. All
     render the same fields, with the same ids and names, in the same order. */
  function formHtml(v = {}, { customerSearch = false, sections = customerSearch ? FORM_SECTIONS : null } = {}) {
    const f = {
      customer: `
          <div class="field span-2">
            ${customerSearch
              ? `<label for="vf-customer-search">Customer <span class="req">*</span></label>
            ${customerPickerHtml(v.customerId)}`
              : `<label for="vf-customer">Customer <span class="req">*</span></label>
            <select class="select" id="vf-customer" name="customerId">${customerOptions(v.customerId)}</select>`}
            <div class="field__error" data-err="customerId"></div>
          </div>`,
      reg: `
          <div class="field">
            <label for="vf-reg">Registration Number <span class="req">*</span></label>
            <input class="input" id="vf-reg" name="regNo" value="${esc(v.regNo || '')}" placeholder="DHAKA-METRO-GA-1234" autocomplete="off">
            <div class="field__error" data-err="regNo"></div>
          </div>`,
      year: `
          <div class="field">
            <label for="vf-year">Year</label>
            <input class="input" id="vf-year" name="year" type="text" inputmode="numeric" value="${esc(v.year || '')}">
            <div class="field__error" data-err="year"></div>
          </div>`,
      brand: `
          <div class="field">
            <label for="vf-brand">Brand <span class="req">*</span></label>
            <div class="cust-picker">
              <input class="input" id="vf-brand" name="brand" value="${esc(v.brand || '')}" placeholder="🔍 Search brand" autocomplete="off"
                     role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="vf-brand-list">
              <ul class="cust-picker__list" id="vf-brand-list" role="listbox" aria-label="Matching brands" hidden></ul>
            </div>
            <div class="field__error" data-err="brand"></div>
          </div>`,
      model: `
          <div class="field">
            <label for="vf-model">Model <span class="req">*</span></label>
            <div class="cust-picker">
              <input class="input" id="vf-model" name="model" value="${esc(v.model || '')}" placeholder="🔍 Search model" autocomplete="off"
                     role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="vf-model-list">
              <ul class="cust-picker__list" id="vf-model-list" role="listbox" aria-label="Matching models" hidden></ul>
            </div>
            <div class="field__error" data-err="model"></div>
          </div>`,
      color: `
          <div class="field">
            <label for="vf-color">Color</label>
            <div class="cust-picker">
              <input class="input" id="vf-color" name="color" value="${esc(v.color || '')}" placeholder="🔍 Search color" autocomplete="off"
                     role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="vf-color-list">
              <ul class="cust-picker__list" id="vf-color-list" role="listbox" aria-label="Matching colors" hidden></ul>
            </div>
          </div>`,
      mileage: `
          <div class="field">
            <label for="vf-mileage">Mileage (km)</label>
            <input class="input" id="vf-mileage" name="mileage" type="number" min="0" value="${esc(v.mileage || '')}">
            <div class="field__error" data-err="mileage"></div>
          </div>`,
      fuel: `
          <div class="field">
            <label for="vf-fuel">Fuel Type</label>
            <select class="select" id="vf-fuel" name="fuelType">${selectOptions(FUEL_TYPES, v.fuelType)}</select>
          </div>`,
      trans: `
          <div class="field">
            <label for="vf-trans">Transmission</label>
            <select class="select" id="vf-trans" name="transmission">${selectOptions(TRANSMISSIONS, v.transmission)}</select>
          </div>`,
      vin: `
          <div class="field">
            <label for="vf-vin">VIN</label>
            <input class="input" id="vf-vin" name="vin" value="${esc(v.vin || '')}" autocomplete="off">
          </div>`,
      chassis: `
          <div class="field">
            <label for="vf-chassis">Chassis Number</label>
            <input class="input" id="vf-chassis" name="chassisNo" value="${esc(v.chassisNo || '')}" autocomplete="off">
          </div>`,
      engine: `
          <div class="field">
            <label for="vf-engine">Engine Number</label>
            <input class="input" id="vf-engine" name="engineNo" value="${esc(v.engineNo || '')}" autocomplete="off">
          </div>`,
      next: `
          <div class="field">
            <label for="vf-next">Next Service Date</label>
            <input class="input" id="vf-next" name="nextServiceDate" type="date" value="${esc(v.nextServiceDate || '')}">
          </div>`,
      status: `
          <div class="field">
            <label for="vf-status">Status</label>
            <select class="select" id="vf-status" name="status">
              <option${(v.status || 'Active') === 'Active' ? ' selected' : ''}>Active</option>
              <option${v.status === 'Inactive' ? ' selected' : ''}>Inactive</option>
            </select>
          </div>`,
      notes: `
          <div class="field span-2">
            <label for="vf-notes">Notes</label>
            <textarea class="textarea" id="vf-notes" name="notes" rows="2">${esc(v.notes || '')}</textarea>
          </div>`
    };
    if (!sections) {
      return `
      <form id="vehForm" novalidate>
        <div class="form-grid">
${Object.values(f).join('\n')}
        </div>
      </form>`;
    }
    return `
      <form id="vehForm" class="veh-form" novalidate>
        ${sections.map(s => `
        <div class="form-section form-section--${s.key}" role="group" aria-labelledby="vfs-${s.key}">
          <div class="form-section__head">
            <span class="form-section__icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="${s.icon}"/></svg></span>
            <div>
              <h3 class="form-section__title" id="vfs-${s.key}">${s.title}</h3>
              <p class="form-section__desc">${s.desc}</p>
            </div>
          </div>
          <div class="form-grid${s.cols === 3 ? ' form-grid--3' : ''} form-section__body">
${s.fields.map(k => f[k]).join('\n')}
          </div>
        </div>`).join('')}
      </form>`;
  }

  /* Registration number: trim, collapse inner whitespace to one space and
     uppercase -- applied only when the form is saved. No format pattern is
     enforced (old, reconditioned and other formats all exist); only a sane
     length, with the maximum matching what the API accepts. */
  const REG_MIN = 3;
  const REG_MAX = 40;
  const normalizeRegNo = s => String(s || '').trim().replace(/\s+/g, ' ').toUpperCase();

  /* Year is optional; when given it must be exactly 4 digits (no other characters)
     and within the database's range, 1900-2200. */
  const YEAR_RE = /^[0-9]{4}$/;

  function readForm(form) {
    const val = n => form[n].value.trim();
    return {
      customerId: val('customerId'), regNo: normalizeRegNo(form.regNo.value),
      brand: val('brand'), model: val('model'),
      // a Year that is not exactly 4 digits stays text so validate() can reject it
      year: val('year') === '' ? '' : YEAR_RE.test(val('year')) ? Number(val('year')) : val('year'),
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

    if (!values.customerId) {
      errors.customerId = 'Select the customer who owns this vehicle.';
    } else if (!Storage.getById('customers', values.customerId)) {
      errors.customerId = 'Selected customer no longer exists.';
    }
    if (!values.regNo) {
      errors.regNo = 'Registration number is required.';
    } else if (values.regNo.length < REG_MIN) {
      errors.regNo = `Registration number is too short (at least ${REG_MIN} characters).`;
    } else if (values.regNo.length > REG_MAX) {
      errors.regNo = `Registration number is too long (at most ${REG_MAX} characters).`;
    } else {
      const norm = values.regNo.replace(/[\s-]/g, '').toLowerCase();
      const dup = Storage.getData('vehicles').find(v =>
        v.id !== editingId && (v.regNo || '').replace(/[\s-]/g, '').toLowerCase() === norm);
      if (dup) errors.regNo = 'A vehicle with this registration number already exists.';
    }
    if (!values.brand) errors.brand = 'Brand is required.';
    if (!values.model) errors.model = 'Model is required.';
    if (typeof values.year === 'string' && values.year !== '')
      errors.year = 'Year must be exactly 4 digits.';
    else if (values.year !== '' && (values.year < 1900 || values.year > 2200))
      errors.year = 'Year must be between 1900 and 2200.';
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

  /* Add and Edit Vehicle presentation: an icon and a one-line description in
     the shared modal header; .veh-add scopes the sectioned form styling. */
  function decorateFormModal(ov, subtitle) {
    const modal = ov.querySelector('.modal');
    modal.classList.add('veh-add');
    const title = modal.querySelector('.modal__head h2');
    title.insertAdjacentHTML('beforebegin', `<span class="veh-add__icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="${FORM_SECTIONS[1].icon}"/></svg></span>`);
    const titles = document.createElement('div');
    titles.className = 'veh-add__titles';
    title.replaceWith(titles);
    titles.append(title);
    titles.insertAdjacentHTML('beforeend', `<p class="veh-add__sub" id="veh-add-sub">${subtitle}</p>`);
    modal.setAttribute('aria-describedby', 'veh-add-sub');
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
    decorateFormModal(ov, 'Add a new vehicle to the customer profile');
    bindCustomerPicker(ov);
    bindBrandPicker(ov);
    bindModelPicker(ov);
    bindColorPicker(ov);
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
      body: formHtml(v, { sections: EDIT_SECTIONS }),
      footer: `<button class="btn btn--ghost" data-modal-close>Cancel</button>
               <button class="btn btn--primary" data-save>Save Changes</button>`
    });
    decorateFormModal(ov, 'Update vehicle information');
    bindBrandPicker(ov);
    bindModelPicker(ov);
    bindColorPicker(ov);
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
      : emptyState('No service history yet.', 'Service records will appear here once available.');

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
      : emptyState('No invoice history yet.', 'Invoice records will appear here once available.');

    const TECH = ['VIN', 'Chassis No', 'Engine No'];
    const item = ([k, val]) => `<div class="vd-item"><span class="vd-item__label">${k}</span><strong class="vd-item__value">${esc(String(val))}</strong></div>`;
    const stat = (icon, value, label, tone = '') =>
      `<div class="vd-stat${tone ? ' vd-stat--' + tone : ''}"><span class="vd-stat__icon" aria-hidden="true">${svg(icon, 18)}</span>` +
      `<div><strong>${value}</strong><span>${label}</span></div></div>`;

    const ov = Modal.open({
      title: `${v.brand} ${v.model} — ${v.regNo}`,
      size: 'lg',
      body: `
        <div class="vd">
          ${detailSection('ident', ICONS.vehicle, 'Vehicle Identification', 'Basic information about this vehicle', `
            <div class="vd-ident">
              <div class="vd-photo" role="img" aria-label="No vehicle photo">${svg(ICONS.vehicle, 52)}<span>No vehicle photo</span></div>
              <div class="vd-grid">${info.filter(([k]) => !TECH.includes(k)).map(item).join('')}</div>
            </div>`)}
          ${detailSection('tech', ICONS.wrench, 'Technical Details', 'Identification numbers and technical information', `
            <div class="vd-grid">${info.filter(([k]) => TECH.includes(k)).map(item).join('')}</div>`)}
          ${detailSection('owner', ICONS.person, 'Owner Information', 'Registered owner details', owner ? `
            <div class="vd-grid vd-grid--2">
              ${item(['Name', `${owner.name} (${owner.id})`])}
              ${item(['Phone', owner.phone])}
              ${item(['Email', owner.email || '—'])}
              ${item(['Address', owner.address || '—'])}
            </div>` : `<p class="vd-note">Owner record not found (${esc(v.customerId || 'none')}).</p>`)}
          ${detailSection('summary', ICONS.chart, 'Service Summary', 'Quick overview of service and payment information', `
            <div class="vd-stats">
              ${stat(ICONS.wrench, st.serviceCount, 'Total Services')}
              ${stat(ICONS.invoice, money(st.totalSpent), 'Total Spent')}
              ${stat(ICONS.card, money(st.totalPaid), 'Total Paid', 'good')}
              ${stat(ICONS.clock, money(st.totalDue), 'Total Due', st.totalDue > 0 ? 'bad' : '')}
              ${stat(ICONS.calendar, st.lastServiceDate ? fmtDate(st.lastServiceDate) : 'No service yet', 'Last Service')}
              ${stat(ICONS.calendar, v.nextServiceDate ? fmtDate(v.nextServiceDate) : '—', 'Next Service')}
            </div>`)}
          ${detailSection('history', ICONS.job, 'Service History', '', historyHtml, jobs.length > 0)}
          ${detailSection('invoices', ICONS.invoice, 'Invoice History', '', invoiceHtml, invs.length > 0)}
        </div>`,
      footer: `
        ${owner ? `<a class="btn btn--ghost" href="customers.html?view=${encodeURIComponent(owner.id)}">${svg(ICONS.eye, 16)}View Customer</a>` : ''}
        <button class="btn btn--ghost" data-modal-close>Close</button>
        <button class="btn btn--primary" data-edit-from-view>${svg(ICONS.edit, 16)}Edit Vehicle</button>`
    });
    // Details-only presentation: vehicle icon, the model as the title with the
    // registration and status beneath it. The dialog keeps its full aria-label.
    // (Skipped when Modal.open hands back no real element, as in the unit tests' stub.)
    const modal = ov.querySelector('.modal');
    if (modal && modal.classList) {
      modal.classList.add('veh-view');
      const title = modal.querySelector('.modal__head h2');
      title.textContent = `${v.brand} ${v.model}`;
      title.insertAdjacentHTML('beforebegin', `<span class="veh-view__icon" aria-hidden="true">${svg(ICONS.vehicle, 26)}</span>`);
      const titles = document.createElement('div');
      titles.className = 'veh-view__titles';
      title.replaceWith(titles);
      titles.append(title);
      titles.insertAdjacentHTML('beforeend', `<div class="veh-view__meta"><span class="veh-view__reg">${esc(v.regNo)}</span>${badge(v.status || 'Active')}</div>`);
    }
    ov.querySelector('[data-edit-from-view]').addEventListener('click', () => {
      Modal.close();
      openEditModal(id);
    });
  }

  /* Icons for the details view, taken from the sidebar and table actions so
     the modal uses the app's existing icon set. */
  const ICONS = {
    vehicle: FORM_SECTIONS[1].icon,
    person: FORM_SECTIONS[0].icon,
    wrench: FORM_SECTIONS[2].icon,
    invoice: FORM_SECTIONS[3].icon,
    chart: 'M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z',
    job: 'M20 6h-4V4c0-1.1-.9-2-2-2h-4C8.9 2 8 2.9 8 4v2H4c-1.1 0-2 .9-2 2v11c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zM10 4h4v2h-4V4z',
    card: 'M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4v-6h16v6zm0-10H4V6h16v2z',
    calendar: 'M19 4h-1V2h-2v2H8V2H6v2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V10h14v10zM5 8V6h14v2H5z',
    clock: 'M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm0 18c-4.4 0-8-3.6-8-8s3.6-8 8-8 8 3.6 8 8-3.6 8-8 8zm.5-13H11v6l5.2 3.2.8-1.3-4.5-2.7V7z',
    eye: 'M12 4.5C7 4.5 2.7 7.6 1 12c1.7 4.4 6 7.5 11 7.5s9.3-3.1 11-7.5c-1.7-4.4-6-7.5-11-7.5zm0 12.5c-2.8 0-5-2.2-5-5s2.2-5 5-5 5 2.2 5 5-2.2 5-5 5zm0-8c-1.7 0-3 1.3-3 3s1.3 3 3 3 3-1.3 3-3-1.3-3-3-3z',
    edit: 'M3 17.2V21h3.8l11-11.1-3.7-3.7L3 17.2zM20.7 7c.4-.4.4-1 0-1.4l-2.3-2.3c-.4-.4-1-.4-1.4 0l-1.8 1.8 3.7 3.7L20.7 7z'
  };
  const svg = (d, size) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor" aria-hidden="true"><path d="${d}"/></svg>`;

  function detailSection(key, icon, title, desc, content, flush = false) {
    return `
          <section class="form-section vd-section vd-section--${key}" aria-labelledby="vd-${key}">
            <div class="form-section__head">
              <span class="form-section__icon" aria-hidden="true">${svg(icon, 18)}</span>
              <div>
                <h3 class="form-section__title" id="vd-${key}">${title}</h3>
                ${desc ? `<p class="form-section__desc">${desc}</p>` : ''}
              </div>
            </div>
            <div class="vd-section__body${flush ? ' vd-section__body--flush' : ''}">${content}</div>
          </section>`;
  }

  function emptyState(title, hint) {
    return `<div class="vd-empty">${svg(ICONS.invoice, 26)}<p>${title}</p><span>${hint}</span></div>`;
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
