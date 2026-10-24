// The sole normalization/formatting path. No cart cents, exchange rates or payment inference.
const digits = { DOP: 2, USD: 2, EUR: 2, CAD: 2, GBP: 2, JPY: 0, KWD: 3 };
const statuses = {
  pending: 'Pendiente de pago', authorized: 'Autorizado, no pagado',
  partially_paid: 'Pago parcial', paid: 'Pagado',
  partially_refunded: 'Reembolso parcial', refunded: 'Reembolsado', voided: 'Anulado'
};
function requireValue(condition) {
  if (!condition) throw new Error('invalid_order');
}
function text(value, max = 160) {
  requireValue(typeof value === 'string' && value.trim().length > 0 && value.length <= max &&
    !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value));
  return value;
}
function money(amount, currency) {
  requireValue(typeof amount === 'string' && /^(0|[1-9]\d{0,17})(\.\d{1,6})?$/.test(amount));
  const [whole, fraction = ''] = amount.split('.');
  const scale = digits[currency];
  requireValue(!/[1-9]/.test(fraction.slice(scale)));
  const units = BigInt(whole) * 10n ** BigInt(scale) + BigInt(fraction.slice(0, scale).padEnd(scale, '0') || '0');
  const exact = units.toString().padStart(scale + 1, '0');
  return scale ? `${exact.slice(0, -scale)}.${exact.slice(-scale)}` : exact;
}
function moneySet(set, amount, currency) {
  requireValue(set && typeof set === 'object');
  for (const side of ['shop_money', 'presentment_money']) {
    requireValue(set[side]?.currency_code === currency);
    requireValue(money(set[side].amount, currency) === amount);
  }
}
export function prepareOrder(order) {
  requireValue(order && typeof order === 'object' && !Array.isArray(order));
  const id = typeof order.id === 'number' && Number.isSafeInteger(order.id) ? String(order.id) : order.id;
  requireValue(typeof id === 'string' && /^[1-9]\d{0,19}$/.test(id));
  const name = text(order.name, 80);
  const currency = order.currency;
  requireValue(typeof currency === 'string' && Object.hasOwn(digits, currency) &&
    typeof order.financial_status === 'string' && Object.hasOwn(statuses, order.financial_status));
  if (order.presentment_currency !== undefined) requireValue(order.presentment_currency === currency);
  const values = {};
  for (const field of ['total_price', 'total_discounts', 'total_tax']) {
    values[field] = money(order[field], currency);
    if (order[`${field}_set`] !== undefined) moneySet(order[`${field}_set`], values[field], currency);
  }
  const shipping = money(order.total_shipping_price_set?.shop_money?.amount, currency);
  moneySet(order.total_shipping_price_set, shipping, currency);
  requireValue(Array.isArray(order.line_items) && order.line_items.length > 0 && order.line_items.length <= 100);
  const lines = order.line_items.map(item => {
    requireValue(item && Number.isSafeInteger(item.quantity) && item.quantity >= 1 && item.quantity <= 10000);
    const variant = item.variant_title === null || item.variant_title === undefined || item.variant_title === ''
      ? '' : ` — ${text(item.variant_title)}`;
    return `• ${text(item.title)}${variant} × ${item.quantity}`;
  });
  const scenario = order._mock_delivery ?? 'success';
  requireValue(['success', 'transient', 'transient-always', 'permanent', 'ambiguous', 'interrupted'].includes(scenario));
  const buyer = order._mock_buyer;
  const reason = buyer?.consent !== true || buyer?.evidence !== 'fixture-opt-in-v1' ? 'missing_consent'
    : typeof buyer.phone !== 'string' || !/^\+[1-9]\d{7,14}$/.test(buyer.phone) ? 'invalid_recipient' : null;
  return {
    id, scenario, reason, recipient: reason ? null : buyer.phone,
    message: reason ? null : [
      `Pedido recibido ${name}`, ...lines,
      `Total: ${currency} ${values.total_price}`, `Descuento: ${currency} ${values.total_discounts}`,
      `Envío: ${currency} ${shipping}`, `Impuestos: ${currency} ${values.total_tax}`,
      `Estado financiero registrado: ${order.financial_status} (${statuses[order.financial_status]}).`,
      'Este mensaje confirma la recepción del pedido, no valida pagos.'
    ].join('\n')
  };
}
