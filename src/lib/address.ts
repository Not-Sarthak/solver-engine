// addresses arrive from contracts checksummed and from callers lower cased, so === matches nothing.
export function isSameAddress(a: string, b: string): boolean {
    return a.toLowerCase() === b.toLowerCase();
}
