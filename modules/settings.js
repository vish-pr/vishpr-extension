// Settings Management
import { elements } from './dom.js';
import { addMessage } from './chat.js';
import {
  setApiKey,
  getModels,
  setModels,
  getDefaultModels,
  getEndpoints,
  setEndpoints,
  getConfiguredEndpoints,
  fetchModelsForEndpoint,
  fetchAvailableProviders,
  verifyApiKey,
  verifyModel,
  PREDEFINED_ENDPOINTS,
  OPENROUTER_ID
} from './llm/index.js';
import { getModelStatsCounter, modelStatsKey } from './debug/time-bucket-counter.js';
import Sortable from 'sortablejs';
import { matchSorter } from 'match-sorter';

let currentEndpoints = {}, currentModels = null;
let endpointModelsCache = new Map();
let openrouterProvidersCache = null;
const verificationStatus = new Map();
const endpointVerificationStatus = new Map();
const TIERS = ['HIGH', 'MEDIUM', 'LOW'];
const STATUS = {
  VALID: { inputClass: 'input-success', textClass: 'text-success', icon: '✓' },
  INVALID: { inputClass: 'input-error', textClass: 'text-error', icon: '✗' },
  VERIFYING: { inputClass: 'input-warning', textClass: 'text-warning', icon: '⏳' }
};

const tpl = id => document.getElementById(id).content.cloneNode(true).firstElementChild;
const getListEl = tier => elements[`modelList${tier.charAt(0) + tier.slice(1).toLowerCase()}`];

// ============ Endpoints ============

function renderEndpoints() {
  const list = elements.endpointsList, configured = Object.entries(currentEndpoints);
  list.innerHTML = '';
  if (!configured.length) { list.innerHTML = '<li class="text-center text-xs opacity-50 py-4">No endpoints configured</li>'; return; }

  for (const [id, config] of configured) {
    const el = tpl('tpl-endpoint-item');
    el.dataset.endpoint = id;
    el.querySelector('.endpoint-name').textContent = PREDEFINED_ENDPOINTS[id]?.name || id;
    const keyEl = el.querySelector('.endpoint-key');
    if (config.apiKey) keyEl.textContent = config.apiKey.slice(0, 8) + '...';
    else if (config.url) { try { keyEl.textContent = new URL(config.url).hostname; } catch { keyEl.textContent = config.url; } }
    else keyEl.textContent = 'no key';

    // Show verification status
    const statusEl = el.querySelector('.endpoint-status'), status = endpointVerificationStatus.get(id);
    if (status?.verified === true) statusEl.innerHTML = '<div class="tooltip tooltip-right" data-tip="API key verified"><div class="status status-success"></div></div>';
    else if (status?.verified === false) statusEl.innerHTML = `<div class="tooltip tooltip-right tooltip-error" data-tip="${(status.error || 'Verification failed').replace(/"/g, '&quot;')}"><div class="status status-error"></div></div>`;
    else if (status?.verifying) statusEl.innerHTML = '<div class="tooltip tooltip-right" data-tip="Verifying..."><div class="status status-verifying"></div></div>';
    else if (config.apiKey && PREDEFINED_ENDPOINTS[id]) statusEl.innerHTML = '<div class="status status-idle"></div>';

    list.appendChild(el);
  }
}

async function verifyAllEndpoints() {
  const tasks = [];

  // First pass: mark all endpoints with API keys as verifying
  for (const [id, config] of Object.entries(currentEndpoints)) {
    if (!config.apiKey || !PREDEFINED_ENDPOINTS[id] || endpointVerificationStatus.has(id)) continue;
    endpointVerificationStatus.set(id, { verifying: true });
  }
  renderEndpoints();

  // Second pass: start verification tasks
  for (const [id, config] of Object.entries(currentEndpoints)) {
    const status = endpointVerificationStatus.get(id);
    if (!config.apiKey || !PREDEFINED_ENDPOINTS[id] || !status?.verifying) continue;
    tasks.push(verifyApiKey(config.apiKey, id).then(result => {
      endpointVerificationStatus.set(id, { verified: result.valid, error: result.error });
      renderEndpoints();
    }));
  }
  await Promise.all(tasks);
}

function createEndpointEditingRow(id = '', config = {}) {
  const el = tpl('tpl-endpoint-editing');
  const typeSelect = el.querySelector('.endpoint-type-select'), nameInput = el.querySelector('.endpoint-name-input');
  const urlInput = el.querySelector('.endpoint-url-input'), keyInput = el.querySelector('.endpoint-key-input');

  if (id && PREDEFINED_ENDPOINTS[id]) {
    typeSelect.value = id; urlInput.value = PREDEFINED_ENDPOINTS[id].url;
    urlInput.readOnly = true; urlInput.classList.add('opacity-50');
  } else if (id) {
    typeSelect.value = ''; nameInput.value = id;
    nameInput.classList.remove('hidden'); typeSelect.classList.add('hidden');
    urlInput.value = config.url || '';
  }
  keyInput.value = config.apiKey || '';

  typeSelect.addEventListener('change', () => {
    const val = typeSelect.value, isPredefined = !!val;
    nameInput.classList.toggle('hidden', isPredefined);
    urlInput.readOnly = isPredefined; urlInput.classList.toggle('opacity-50', isPredefined);
    urlInput.value = isPredefined ? PREDEFINED_ENDPOINTS[val].url : '';
    if (!isPredefined) nameInput.value = '';
  });

  el.dataset.endpoint = id;
  return el;
}

async function handleEndpointSave(row) {
  const typeSelect = row.querySelector('.endpoint-type-select'), nameInput = row.querySelector('.endpoint-name-input');
  const urlInput = row.querySelector('.endpoint-url-input'), keyInput = row.querySelector('.endpoint-key-input');
  const saveBtn = row.querySelector('.save'), id = typeSelect.value || nameInput.value.trim();
  if (!id) { addMessage('system', '✗ Endpoint name is required'); return; }

  const predefined = PREDEFINED_ENDPOINTS[id], apiKey = keyInput.value.trim(), config = { apiKey };
  if (!predefined) {
    config.url = urlInput.value.trim();
    if (!config.url) { addMessage('system', '✗ URL is required for custom endpoints'); return; }
  }

  if (predefined && apiKey) {
    const originalHtml = saveBtn.innerHTML;
    saveBtn.disabled = true; saveBtn.innerHTML = '<span class="loading loading-spinner loading-xs"></span>';
    addMessage('system', `Verifying ${predefined.name} API key...`);
    const result = await verifyApiKey(apiKey, id);
    saveBtn.disabled = false; saveBtn.innerHTML = originalHtml;
    if (!result.valid) {
      endpointVerificationStatus.set(id, { verified: false, error: result.error });
      addMessage('system', `✗ API key verification failed: ${result.error}`);
      return;
    }
    endpointVerificationStatus.set(id, { verified: true });
  } else {
    endpointVerificationStatus.delete(id);
  }

  const oldId = row.dataset.endpoint;
  if (oldId && oldId !== id) {
    delete currentEndpoints[oldId];
    endpointVerificationStatus.delete(oldId);
  }

  currentEndpoints[id] = config;
  await setEndpoints(currentEndpoints);
  endpointModelsCache.delete(id); renderEndpoints();
  addMessage('system', `✓ Endpoint ${predefined?.name || id} saved`);
}

function handleEndpointDelete(id) {
  delete currentEndpoints[id];
  endpointVerificationStatus.delete(id);
  setEndpoints(currentEndpoints);
  renderEndpoints();
  addMessage('system', '✓ Endpoint removed');
}

function handleEndpointEdit(id) {
  elements.endpointsList.querySelector(`[data-endpoint="${id}"]`).replaceWith(createEndpointEditingRow(id, currentEndpoints[id]));
}

function handleEndpointAdd() {
  elements.endpointsList.querySelector('.text-center')?.remove();
  elements.endpointsList.appendChild(createEndpointEditingRow());
}

function setupEndpointsSection() {
  elements.addEndpointBtn.addEventListener('click', handleEndpointAdd);

  elements.endpointsList.addEventListener('click', e => {
    const btn = e.target.closest('button');
    const row = btn?.closest('li');
    if (!row) return;

    if (btn.classList.contains('edit')) {
      handleEndpointEdit(row.dataset.endpoint);
    } else if (btn.classList.contains('delete')) {
      handleEndpointDelete(row.dataset.endpoint);
    } else if (btn.classList.contains('save')) {
      handleEndpointSave(row);
    } else if (btn.classList.contains('cancel')) {
      renderEndpoints();
    }
  });
}

// ============ Models ============

async function verifyAllModels() {
  const tasks = [], counter = getModelStatsCounter(), tiersToRender = new Set();
  let needsSave = false;

  // First pass: mark all models as verifying
  for (const tier of TIERS) {
    for (let i = 0; i < (currentModels[tier]?.length || 0); i++) {
      const [ep, m] = currentModels[tier][i], key = `${tier}:${i}`;
      if (!m || verificationStatus.has(key)) continue;
      verificationStatus.set(key, { verifying: true });
      tiersToRender.add(tier);
    }
  }

  // Render all tiers with verifying state
  for (const tier of tiersToRender) renderTierModels(tier);

  // Second pass: start verification tasks
  for (const tier of TIERS) {
    for (let i = 0; i < (currentModels[tier]?.length || 0); i++) {
      const [ep, m, prov, noTool] = currentModels[tier][i], key = `${tier}:${i}`;
      const status = verificationStatus.get(key);
      if (!m || !status?.verifying) continue;
      tasks.push(verifyModel(ep, m, prov).then(async result => {
        verificationStatus.set(key, { verified: result.valid, error: result.error });
        if (result.noToolChoice && !noTool) { currentModels[tier][i] = [ep, m, prov, true]; needsSave = true; }
        await counter.increment(modelStatsKey(ep, m, prov), result.valid ? 'success' : 'error');
        renderTierModels(tier);
      }));
    }
  }
  await Promise.all(tasks);
  if (needsSave) saveModels();
}

function createModelItem(endpoint, model, openrouterProvider, noToolChoice, tier, index, stats) {
  const el = tpl('tpl-model-item');
  el.dataset.tier = tier; el.dataset.index = index;
  el.querySelector('.model-endpoint').textContent = endpoint;
  el.querySelector('.model-name').textContent = model;
  const providerEl = el.querySelector('.model-provider');
  if (openrouterProvider && providerEl) providerEl.textContent = openrouterProvider;

  const statusEl = el.querySelector('.status-indicator'), status = verificationStatus.get(`${tier}:${index}`);
  if (status?.verified === true) statusEl.innerHTML = '<div class="tooltip tooltip-right" data-tip="Verified"><div class="status status-success"></div></div>';
  else if (status?.verified === false) statusEl.innerHTML = `<div class="tooltip tooltip-right tooltip-error" data-tip="${(status.error || 'Unknown error').replace(/"/g, '&quot;')}"><div class="status status-error"></div></div>`;
  else if (status?.verifying) statusEl.innerHTML = '<div class="tooltip tooltip-right" data-tip="Verifying..."><div class="status status-verifying"></div></div>';
  else statusEl.innerHTML = '<div class="status status-idle"></div>';

  if (noToolChoice) {
    const warningEl = el.querySelector('.warning-indicator');
    warningEl.classList.remove('hidden');
    warningEl.innerHTML = '<div class="tooltip tooltip-bottom tooltip-warning" data-tip="No tool_choice support"><svg class="w-3 h-3 text-warning" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L1 21h22L12 2zm0 4l7.5 13h-15L12 6zm-1 5v4h2v-4h-2zm0 6v2h2v-2h-2z"/></svg></div>';
  }

  if (stats) {
    const success = stats.success?.total || 0, error = stats.error?.total || 0, total = success + error;
    if (total > 0) {
      const rate = Math.round((success / total) * 100), rateClass = rate >= 90 ? 'text-success' : rate >= 70 ? 'text-warning' : 'text-error';
      el.querySelector('.model-stats').innerHTML = `<span class="${rateClass} font-medium">${rate}%</span><span class="opacity-50">·</span><span>${total} calls</span>`;
    }
  }
  return el;
}

async function createModelEditingRow(endpoint, model, openrouterProvider, tier, index) {
  const el = tpl('tpl-model-editing');
  el.dataset.tier = tier; el.dataset.index = index;
  const endpointSelect = el.querySelector('.model-endpoint-select'), configuredEndpoints = Object.keys(currentEndpoints);

  if (!configuredEndpoints.length) {
    endpointSelect.innerHTML = '<option value="">No endpoints configured</option>';
    endpointSelect.disabled = true;
  } else {
    endpointSelect.innerHTML = configuredEndpoints.map(id => `<option value="${id}">${PREDEFINED_ENDPOINTS[id]?.name || id}</option>`).join('');
    endpointSelect.value = endpoint || configuredEndpoints[0];
  }

  const modelInput = el.querySelector('.model-name-input'), routerRow = el.querySelector('.model-router-row'), routerInput = el.querySelector('.model-router-input');
  modelInput.value = model || '';
  const updateRouterVisibility = epId => {
    if (!routerRow || !routerInput) return;
    routerRow.classList.toggle('hidden', epId !== OPENROUTER_ID);
    if (epId !== OPENROUTER_ID) routerInput.value = '';
  };
  if (routerInput) routerInput.value = openrouterProvider || '';
  updateRouterVisibility(endpointSelect.value);

  endpointSelect.addEventListener('change', () => {
    updateRouterVisibility(endpointSelect.value);
    updateModelAutocomplete(modelInput, el.querySelector('.model-autocomplete'), endpointSelect.value);
    if (routerInput) routerInput.value = '';
  });
  return el;
}

function positionDropdown(input, listEl) {
  const rect = input.getBoundingClientRect();
  Object.assign(listEl.style, { left: `${rect.left}px`, width: `${rect.width}px`, top: `${rect.bottom + 4}px`, bottom: 'auto' });
}

async function updateAutocomplete(input, listEl, { getData, keys, sortKey, renderItem }) {
  const data = await getData();
  if (!data) { listEl.classList.add('hidden'); return; }

  const q = input.value.trim();
  const matches = q ? matchSorter(data, q, { keys }) : [...data].sort((a, b) => a[sortKey].localeCompare(b[sortKey]));
  if (!matches.length) { listEl.classList.add('hidden'); return; }

  listEl.innerHTML = matches.slice(0, 50).map(renderItem).join('');
  positionDropdown(input, listEl);
  listEl.classList.remove('hidden');
}

const updateModelAutocomplete = (input, listEl, endpointId) => updateAutocomplete(input, listEl, {
  getData: async () => {
    if (!endpointId || !currentEndpoints[endpointId]) return null;
    if (!endpointModelsCache.has(endpointId)) endpointModelsCache.set(endpointId, await fetchModelsForEndpoint(endpointId, currentEndpoints));
    return endpointModelsCache.get(endpointId);
  },
  keys: ['id', 'name'], sortKey: 'id',
  renderItem: m => `<li class="px-2 py-2 rounded-lg cursor-pointer hover:bg-base-300 text-xs" data-model-id="${m.id}"><div class="font-mono truncate">${m.id}</div>${m.name !== m.id ? `<div class="opacity-50 text-xs truncate">${m.name}</div>` : ''}</li>`
});

const updateRouterAutocomplete = (input, listEl) => updateAutocomplete(input, listEl, {
  getData: async () => (openrouterProvidersCache ??= await fetchAvailableProviders()),
  keys: ['slug', 'name'], sortKey: 'slug',
  renderItem: p => `<li class="px-2 py-2 rounded-lg cursor-pointer hover:bg-base-300 text-xs" data-provider="${p.slug}"><div class="truncate">${p.name}</div><div class="opacity-50 text-xs truncate">${p.slug}</div></li>`
});

async function renderTierModels(tier) {
  const listEl = getListEl(tier), models = currentModels[tier] || [];
  listEl.innerHTML = '';
  if (!models.length) { listEl.innerHTML = '<li class="text-center text-xs opacity-50 py-4">No models configured</li>'; return; }
  const stats = await getModelStatsCounter().getAllStats();
  models.forEach(([ep, m, prov, noTool], i) => listEl.appendChild(createModelItem(ep, m, prov, noTool, tier, i, stats[modelStatsKey(ep, m, prov)])));
}

const renderAllModels = () => Promise.all(TIERS.map(renderTierModels));

const saveModels = () => setModels(currentModels);

function shiftVerificationStatus(tier, fromIdx, direction) {
  const len = currentModels[tier].length, key = i => `${tier}:${i}`;
  if (direction < 0) {
    for (let i = fromIdx; i < len; i++) {
      const next = verificationStatus.get(key(i + 1));
      next ? verificationStatus.set(key(i), next) : verificationStatus.delete(key(i));
    }
    verificationStatus.delete(key(len - 1));
  } else {
    for (let i = len - 1; i >= fromIdx; i--) {
      const s = verificationStatus.get(key(i));
      s ? verificationStatus.set(key(i + 1), s) : verificationStatus.delete(key(i + 1));
    }
  }
}

async function handleModelEdit(tier, index) {
  const [ep, m, prov] = currentModels[tier][index];
  getListEl(tier).querySelector(`.list-row[data-index="${index}"]`).replaceWith(await createModelEditingRow(ep, m, prov, tier, index));
}

async function handleModelSave(tier, index) {
  const row = getListEl(tier).querySelector(`[data-index="${index}"]`), saveBtn = row.querySelector('.save');
  const endpoint = row.querySelector('.model-endpoint-select').value, model = row.querySelector('.model-name-input').value.trim();
  const providerInput = row.querySelector('.model-router-input')?.value.trim() || '';
  if (!endpoint) { addMessage('system', '✗ Please configure an endpoint first'); return; }
  if (!model) { addMessage('system', '✗ Model name is required'); return; }
  const openrouterProvider = (endpoint === OPENROUTER_ID && providerInput) ? providerInput : null;

  const originalHtml = saveBtn.innerHTML;
  saveBtn.disabled = true;
  saveBtn.innerHTML = '<span class="loading loading-spinner loading-xs"></span>';
  addMessage('system', `Verifying ${model}...`);

  const result = await verifyModel(endpoint, model, openrouterProvider);
  await getModelStatsCounter().increment(modelStatsKey(endpoint, model, openrouterProvider), result.valid ? 'success' : 'error');
  saveBtn.disabled = false; saveBtn.innerHTML = originalHtml;

  verificationStatus.set(`${tier}:${index}`, { verified: result.valid, error: result.error });
  currentModels[tier][index] = [endpoint, model, openrouterProvider, result.noToolChoice || undefined];
  saveModels(); renderTierModels(tier);

  addMessage('system', result.valid
    ? (result.noToolChoice ? '✓ Model verified (no tool_choice support)' : '✓ Model verified and saved')
    : `✗ Model verification failed: ${result.error}`);
}

function handleModelDelete(tier, index) {
  shiftVerificationStatus(tier, index, -1);
  currentModels[tier].splice(index, 1);
  saveModels(); renderTierModels(tier);
  addMessage('system', '✓ Model removed');
}

async function handleModelAdd(tier) {
  const listEl = getListEl(tier), defaultEndpoint = Object.keys(currentEndpoints)[0] || '';
  currentModels[tier].push([defaultEndpoint, '', null, undefined]);
  const index = currentModels[tier].length - 1;

  listEl.innerHTML = '';
  const stats = await getModelStatsCounter().getAllStats();
  currentModels[tier].slice(0, -1).forEach(([ep, m, prov, noTool], i) => listEl.appendChild(createModelItem(ep, m, prov, noTool, tier, i, stats[modelStatsKey(ep, m, prov)])));
  listEl.appendChild(await createModelEditingRow(defaultEndpoint, '', null, tier, index));
  listEl.querySelector('.list-row:last-child .model-name-input').focus();
}

async function handleResetModels() {
  currentModels = getDefaultModels();
  verificationStatus.clear();
  await saveModels(); await renderAllModels();
  addMessage('system', '✓ Models reset to defaults');
  verifyAllModels();
}

// Drag and Drop
const sortableInstances = [];
const getTierFromListId = id => id.replace('modelList', '').toUpperCase();

function setupDragAndDrop() {
  sortableInstances.forEach(s => s.destroy());
  sortableInstances.length = 0;
  ['High', 'Medium', 'Low'].forEach(tierName => sortableInstances.push(Sortable.create(elements[`modelList${tierName}`], {
    group: 'models', animation: 150, ghostClass: 'opacity-40',
    chosenClass: 'bg-base-200', dragClass: 'shadow-lg', filter: '.btn, input, select', preventOnFilter: false,
    onEnd: ({ from, to, oldIndex, newIndex }) => {
      const fromTier = getTierFromListId(from.id), toTier = getTierFromListId(to.id);
      if (fromTier === toTier && oldIndex === newIndex) return;
      const movedStatus = verificationStatus.get(`${fromTier}:${oldIndex}`);
      shiftVerificationStatus(fromTier, oldIndex, -1);
      shiftVerificationStatus(toTier, newIndex, 1);
      movedStatus ? verificationStatus.set(`${toTier}:${newIndex}`, movedStatus) : verificationStatus.delete(`${toTier}:${newIndex}`);
      const [movedModel] = currentModels[fromTier].splice(oldIndex, 1);
      currentModels[toTier].splice(newIndex, 0, movedModel);
      saveModels(); renderAllModels();
    }
  })));
}

function setupModelsSection() {
  setupDragAndDrop();
  document.querySelectorAll('.tier-add-btn').forEach(btn => btn.addEventListener('click', e => { e.stopPropagation(); handleModelAdd(btn.dataset.tier); }));
  elements.resetModelsBtn.addEventListener('click', handleResetModels);

  elements.modelsBody.addEventListener('click', e => {
    const btn = e.target.closest('button');
    const row = btn?.closest('.list-row');

    if (row && row.dataset.index !== undefined) {
      const { tier, index } = row.dataset;
      if (btn.classList.contains('edit')) handleModelEdit(tier, +index);
      else if (btn.classList.contains('delete')) handleModelDelete(tier, +index);
      else if (btn.classList.contains('save')) handleModelSave(tier, +index);
      else if (btn.classList.contains('cancel')) renderTierModels(tier);
      return;
    }

    // Autocomplete selection - model
    const modelItem = e.target.closest('.model-autocomplete li[data-model-id]');
    if (modelItem) {
      e.preventDefault();
      const r = modelItem.closest('.list-row');
      const input = r.querySelector('.model-name-input');
      input.value = modelItem.dataset.modelId;
      r.querySelector('.model-autocomplete').classList.add('hidden');
      input.focus();
    }

    // Autocomplete selection - router
    const routerItem = e.target.closest('.router-autocomplete li[data-provider]');
    if (routerItem) {
      e.preventDefault();
      const r = routerItem.closest('.list-row');
      const input = r.querySelector('.model-router-input');
      input.value = routerItem.dataset.provider;
      r.querySelector('.router-autocomplete').classList.add('hidden');
      input.focus();
    }
  });

  elements.modelsBody.addEventListener('keydown', e => {
    const isModelInput = e.target.classList.contains('model-name-input');
    const isRouterInput = e.target.classList.contains('model-router-input');
    if (!isModelInput && !isRouterInput) return;

    const row = e.target.closest('.list-row');
    const ac = row?.querySelector(isModelInput ? '.model-autocomplete' : '.router-autocomplete');

    if (e.key === 'Enter') {
      const sel = ac?.querySelector('li.bg-base-300');
      if (sel && !ac.classList.contains('hidden')) {
        e.preventDefault();
        e.target.value = isModelInput ? sel.dataset.modelId : sel.dataset.provider;
        ac.classList.add('hidden');
      } else if (isModelInput) {
        row.querySelector('.model-autocomplete')?.classList.add('hidden');
        handleModelSave(row.dataset.tier, +row.dataset.index);
      }
    } else if (e.key === 'Escape') {
      if (!ac?.classList.contains('hidden')) {
        ac.classList.add('hidden');
      } else {
        renderTierModels(row.dataset.tier);
      }
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && ac && !ac.classList.contains('hidden')) {
      e.preventDefault();
      const items = [...ac.querySelectorAll('li')];
      const idx = items.indexOf(ac.querySelector('li.bg-base-300'));
      const next = Math.max(0, Math.min(items.length - 1, idx + (e.key === 'ArrowDown' ? 1 : -1)));
      items.forEach(i => i.classList.remove('bg-base-300'));
      items[next]?.classList.add('bg-base-300');
      items[next]?.scrollIntoView({ block: 'nearest' });
    }
  });

  const handleAutocompleteEvent = (e, hideOnly = false) => {
    const row = e.target.closest('.list-row');
    if (!row) return;
    const isModel = e.target.classList.contains('model-name-input');
    const isRouter = e.target.classList.contains('model-router-input');
    if (!isModel && !isRouter) return;
    const ac = row.querySelector(isModel ? '.model-autocomplete' : '.router-autocomplete');
    if (hideOnly) { setTimeout(() => ac?.classList.add('hidden'), 200); return; }
    isModel ? updateModelAutocomplete(e.target, ac, row.querySelector('.model-endpoint-select').value) : updateRouterAutocomplete(e.target, ac);
  };

  elements.modelsBody.addEventListener('input', handleAutocompleteEvent);
  elements.modelsBody.addEventListener('focusin', handleAutocompleteEvent);
  elements.modelsBody.addEventListener('focusout', e => handleAutocompleteEvent(e, true));
}

// ============ Settings Panel ============

function updateHeaderTitle() {
  const hasEndpoints = Object.keys(currentEndpoints).length > 0;
  document.getElementById('statusDot')?.classList.toggle('active', hasEndpoints);
  const text = document.getElementById('statusText');
  if (text) text.textContent = hasEndpoints ? 'Ready' : 'No Endpoints';
}

async function toggleSettings(show) {
  elements.settingsPanel.classList.toggle('hidden', !show);
  elements.settingsToggle.classList.toggle('btn-active', show);
  if (!show) return;
  renderEndpoints(); await renderAllModels();
}

export async function initSettings() {
  currentEndpoints = await getEndpoints();
  currentModels = await getModels();

  renderEndpoints(); await renderAllModels();
  const hasEndpoints = Object.keys(currentEndpoints).length > 0;
  if (!hasEndpoints) toggleSettings(true);
  updateHeaderTitle();

  elements.settingsToggle.addEventListener('click', () => toggleSettings(elements.settingsPanel.classList.contains('hidden')));
  setupEndpointsSection();
  setupModelsSection();
  if (hasEndpoints) {
    verifyAllEndpoints();
    verifyAllModels();
  }
  return hasEndpoints;
}
