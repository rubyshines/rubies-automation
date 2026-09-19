// Progressive enhancement only: every page works without this file.
(function () {
  // Tabs (sponsor-first arrangement)
  document.querySelectorAll('[data-tabs]').forEach(function (root) {
    root.querySelectorAll('.tab').forEach(function (btn) {
      btn.addEventListener('click', function () {
        root.querySelectorAll('.tab').forEach(function (b) { b.classList.toggle('active', b === btn); });
        root.querySelectorAll('.tab-pane').forEach(function (p) { p.hidden = p.dataset.pane !== btn.dataset.tab; });
      });
    });
  });

  // Chip checkboxes
  document.querySelectorAll('.chip input').forEach(function (input) {
    var sync = function () { input.closest('.chip').classList.toggle('on', input.checked); };
    input.addEventListener('change', sync); sync();
  });

  // Copy buttons
  document.querySelectorAll('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var text = btn.getAttribute('data-copy');
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy'; }, 1500); });
    });
  });

  // Reveal blocks: <input data-reveal="#id" value="ship"> shows #id when checked
  document.querySelectorAll('[data-reveal]').forEach(function (input) {
    var target = document.querySelector(input.getAttribute('data-reveal'));
    if (!target) return;
    var group = input.name ? document.querySelectorAll('input[name="' + input.name + '"]') : [input];
    var sync = function () { target.hidden = !input.checked; };
    group.forEach(function (i) { i.addEventListener('change', sync); });
    sync();
  });

  // Request form: add another item (clone the template row)
  var items = document.getElementById('items');
  var add = document.getElementById('add-item');
  if (items && add) {
    var max = parseInt(add.getAttribute('data-max') || '2', 10);
    var tpl = document.getElementById('item-template');
    var count = function () { return items.querySelectorAll('.item').length; };
    var refresh = function () { add.disabled = count() >= max; };
    add.addEventListener('click', function () {
      if (count() >= max) return;
      var node = tpl.content.firstElementChild.cloneNode(true);
      node.querySelectorAll('[name]').forEach(function (el) { el.name = el.name.replace('__i__', String(count())); });
      node.querySelector('.remove').addEventListener('click', function () { node.remove(); refresh(); });
      items.appendChild(node); refresh();
    });
    items.querySelectorAll('.remove').forEach(function (b) { b.addEventListener('click', function () { b.closest('.item').remove(); refresh(); }); });
    refresh();
  }

  // Personal-email nudge on account forms
  var email = document.querySelector('[data-nudge-email]');
  if (email) {
    var personal = /@(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|me|aol|proton|protonmail)\./i;
    var domain = email.getAttribute('data-centre-domain') || '';
    var box = document.getElementById('nudge');
    var dismissed = false;
    var check = function () {
      if (dismissed || !box) return;
      var v = email.value.trim();
      var show = personal.test(v);
      box.hidden = !show;
      if (show && domain) {
        var local = v.split('@')[0];
        var suggestion = box.querySelector('[data-suggest]');
        if (suggestion) { suggestion.textContent = 'Use ' + local + '@' + domain; suggestion.onclick = function () { email.value = local + '@' + domain; box.hidden = true; }; }
      }
    };
    email.addEventListener('input', check); email.addEventListener('blur', check);
    var keep = box && box.querySelector('[data-keep]');
    if (keep) keep.addEventListener('click', function () { dismissed = true; box.hidden = true; });
  }

  // Fill grid remaining counter (Send the box)
  var grid = document.querySelector('.grid-fill');
  if (grid) {
    var out = document.getElementById('remaining');
    var budget = parseInt(grid.getAttribute('data-budget') || '0', 10);
    var recalc = function () {
      var spent = 0;
      grid.querySelectorAll('input[data-cents]').forEach(function (i) { spent += (parseInt(i.value || '0', 10) || 0) * parseInt(i.getAttribute('data-cents'), 10); });
      if (out) out.textContent = '$' + Math.max(0, (budget - spent) / 100).toFixed(0) + ' of product left to place' + (spent > budget ? ' (over budget)' : '');
    };
    grid.addEventListener('input', recalc); recalc();
  }
})();

// Request form: the colour and size lists follow the chosen style
document.addEventListener('change', function (e) {
  var sel = e.target;
  if (!sel.matches('[data-style-select]')) return;
  var opt = sel.selectedOptions[0];
  var item = sel.closest('.item');
  var colours = (opt.getAttribute('data-colours') || '').split('|').filter(Boolean);
  var colourSel = item.querySelector('[data-colour-select]');
  if (colourSel) colourSel.innerHTML = colours.map(function (c) { return '<option>' + c + '</option>'; }).join('');
  var sizes = (opt.getAttribute('data-sizes') || '').split('|').filter(Boolean);
  var sizeSel = item.querySelector('[data-size-select]');
  if (sizeSel) {
    var keep = sizeSel.value;
    sizeSel.innerHTML = sizes.map(function (s) { return '<option value="' + s + '"' + (s === keep ? ' selected' : '') + '>' + (/^\d+$/.test(s) ? 'Kids ' + s : s) + '</option>'; }).join('');
  }
});
