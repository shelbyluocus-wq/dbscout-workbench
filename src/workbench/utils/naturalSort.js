// Shared table-sort comparison: whole numbers keep numeric order (#7),
// mixed letter-number ids compare the number as a number (C12 before C111).

export function compareSortValues(left, right) {
  const a = String(left ?? "");
  const b = String(right ?? "");
  const numA = Number(a);
  const numB = Number(b);
  if (Number.isFinite(numA) && Number.isFinite(numB)) {
    if (numA < numB) return -1;
    if (numA > numB) return 1;
  }
  return compareNatural(a, b);
}

function compareNatural(a, b) {
  const left = Array.from(a);
  const right = Array.from(b);
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const ca = left[i];
    const cb = right[j];
    if (isAsciiDigit(ca) && isAsciiDigit(cb)) {
      const na = readUnsigned(left, i);
      const nb = readUnsigned(right, j);
      if (na.value !== nb.value) return na.value < nb.value ? -1 : 1;
      i = na.next;
      j = nb.next;
      continue;
    }
    if (ca !== cb) return ca < cb ? -1 : 1;
    i += 1;
    j += 1;
  }
  if (i === left.length && j === right.length) {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  return i === left.length ? -1 : 1;
}

function isAsciiDigit(ch) {
  return ch >= "0" && ch <= "9";
}

function readUnsigned(chars, start) {
  let index = start;
  while (index < chars.length && chars[index] === "0") index += 1;
  const digitsStart = index;
  while (index < chars.length && isAsciiDigit(chars[index])) index += 1;
  const digits = chars.slice(digitsStart, index).join("");
  return {
    value: digits ? BigInt(digits) : 0n,
    next: index,
  };
}
