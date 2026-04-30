/**
 * Unit tests for lib/orderUtils.js — country-based helpers used by order-creation tools.
 *
 * Run: node --test customer-service/test/orderUtils.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { isUSCountry, shouldAddFedExTag } = require('../lib/orderUtils');

describe('isUSCountry', () => {
  it('matches the 2-letter ISO code', () => {
    assert.equal(isUSCountry('US'), true);
    assert.equal(isUSCountry('us'), true);
  });

  it('matches USA and the full country name', () => {
    assert.equal(isUSCountry('USA'), true);
    assert.equal(isUSCountry('United States'), true);
    assert.equal(isUSCountry('  united states  '), true);
  });

  it('returns false for non-US countries', () => {
    assert.equal(isUSCountry('CA'), false);
    assert.equal(isUSCountry('AU'), false);
    assert.equal(isUSCountry('GB'), false);
    assert.equal(isUSCountry('Australia'), false);
  });

  it('returns false for empty/missing values', () => {
    assert.equal(isUSCountry(''), false);
    assert.equal(isUSCountry(null), false);
    assert.equal(isUSCountry(undefined), false);
  });
});

describe('shouldAddFedExTag', () => {
  it('returns true for non-US countries', () => {
    assert.equal(shouldAddFedExTag('CA'), true);
    assert.equal(shouldAddFedExTag('AU'), true);
    assert.equal(shouldAddFedExTag('GB'), true);
    assert.equal(shouldAddFedExTag('Australia'), true);
  });

  it('returns false for US in any form', () => {
    assert.equal(shouldAddFedExTag('US'), false);
    assert.equal(shouldAddFedExTag('us'), false);
    assert.equal(shouldAddFedExTag('USA'), false);
    assert.equal(shouldAddFedExTag('United States'), false);
  });

  it('returns false when country is missing — never tag without a known destination', () => {
    assert.equal(shouldAddFedExTag(''), false);
    assert.equal(shouldAddFedExTag(null), false);
    assert.equal(shouldAddFedExTag(undefined), false);
  });
});
