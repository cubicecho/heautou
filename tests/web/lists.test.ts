import { claimsOf, claimsProblem } from '../../web/src/core/claims.ts';
import { pairsOf } from '../../web/src/core/lists.ts';

describe('pairsOf', () => {
  it('splits each non-blank line at its first separator, trimmed', () => {
    expect(pairsOf(' a = b \n\n c=d=e ', '=')).toEqual([
      { name: 'a', value: 'b' },
      { name: 'c', value: 'd=e' },
    ]);
  });

  it('reads a line without the separator as a name with an empty value', () => {
    expect(pairsOf('alone', '=')).toEqual([{ name: 'alone', value: '' }]);
  });
});

describe('claims', () => {
  it('read a line with no value as an empty claim', () => {
    expect(claimsOf('quota=50GB\nflag')).toEqual([
      { name: 'quota', value: '50GB' },
      { name: 'flag', value: '' },
    ]);
  });

  it('refuse a line with no name', () => {
    expect(claimsProblem('=x')).toContain('=x');
    expect(claimsProblem('quota=1\nflag=')).toBeUndefined();
  });
});
