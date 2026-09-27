const assert = require('assert');
const { validateArguments } = require('../');

describe('validateArguments', function() {
    const schema = {
        type: 'object',
        properties: {
            a: { type: 'string' },
            n: { type: 'integer' },
            e: { enum: ['x', 'y'] }
        },
        required: ['a'],
        additionalProperties: false
    };

    it('should describe every problem', function() {
        const problems = validateArguments(schema, { n: 1.5, e: 'z', q: 1 });
        assert.deepStrictEqual(problems, [
            'missing required property "a"',
            'property "n" must be integer',
            'property "e" must be one of x, y',
            'unexpected property "q"'
        ]);
    });

    it('should return no problems for valid arguments', function() {
        assert.deepStrictEqual(validateArguments(schema, { a: 'hi', n: 3, e: 'y' }), []);
        assert.deepStrictEqual(validateArguments(schema, { a: '' }), []);
    });

    it('should check every JSON type', function() {
        const types = {
            type: 'object',
            properties: {
                s: { type: 'string' },
                num: { type: 'number' },
                i: { type: 'integer' },
                b: { type: 'boolean' },
                o: { type: 'object' },
                arr: { type: 'array' },
                z: { type: 'null' }
            }
        };
        assert.deepStrictEqual(validateArguments(types, { s: 's', num: 1.5, i: 2, b: false, o: {}, arr: [], z: null }), []);
        assert.deepStrictEqual(validateArguments(types, { s: 1, num: 'x', i: '2', b: 'true', o: [], arr: {}, z: 0 }), [
            'property "s" must be string',
            'property "num" must be number',
            'property "i" must be integer',
            'property "b" must be boolean',
            'property "o" must be object',
            'property "arr" must be array',
            'property "z" must be null'
        ]);
    });

    it('should accept any of several types', function() {
        const nullable = { type: 'object', properties: { v: { type: ['string', 'null'] } } };
        assert.deepStrictEqual(validateArguments(nullable, { v: null }), []);
        assert.deepStrictEqual(validateArguments(nullable, { v: 'x' }), []);
        assert.deepStrictEqual(validateArguments(nullable, { v: 3 }), ['property "v" must be string or null']);
    });

    it('should require an object when the schema says so', function() {
        assert.deepStrictEqual(validateArguments({ type: 'object' }, 'nope'), ['arguments must be object']);
        assert.deepStrictEqual(validateArguments({ type: 'object' }, null), ['arguments must be object']);
    });

    it('should check nested objects and array items', function() {
        const nested = {
            type: 'object',
            properties: {
                address: {
                    type: 'object',
                    properties: { city: { type: 'string' } },
                    required: ['city'],
                    additionalProperties: false
                },
                tags: { type: 'array', items: { type: 'string' } },
                sizes: { type: 'array', items: { enum: ['s', 'm'] } }
            }
        };
        assert.deepStrictEqual(validateArguments(nested, { address: { city: 'Oslo' }, tags: ['a', 'b'], sizes: ['s'] }), []);
        assert.deepStrictEqual(validateArguments(nested, { address: { zip: 1 }, tags: ['a', 2], sizes: ['xl'] }), [
            'missing required property "address.city"',
            'unexpected property "address.zip"',
            'property "tags[1]" must be string',
            'property "sizes[0]" must be one of s, m'
        ]);
    });

    it('should check additional properties against a schema', function() {
        const map = { type: 'object', additionalProperties: { type: 'number' } };
        assert.deepStrictEqual(validateArguments(map, { a: 1, b: 2 }), []);
        assert.deepStrictEqual(validateArguments(map, { a: 1, b: 'two' }), ['property "b" must be number']);
    });

    it('should compare enum values that are not strings', function() {
        const numbers = { type: 'object', properties: { n: { enum: [1, 2, { x: 1 }] } } };
        assert.deepStrictEqual(validateArguments(numbers, { n: 2 }), []);
        assert.deepStrictEqual(validateArguments(numbers, { n: { x: 1 } }), []);
        assert.deepStrictEqual(validateArguments(numbers, { n: '2' }), ['property "n" must be one of 1, 2, {"x":1}']);
    });

    it('should allow and check properties that match patternProperties', function() {
        const schema = {
            type: 'object',
            properties: { name: { type: 'string' } },
            patternProperties: { '^x-': { type: 'string' }, '^\\p{Lu}': {} },
            additionalProperties: false
        };
        assert.deepStrictEqual(validateArguments(schema, { name: 'a', 'x-trace': 'b', Émile: 1 }), []);
        assert.deepStrictEqual(validateArguments(schema, { name: 'a', 'x-trace': 1, other: true }), ['property "x-trace" must be string', 'unexpected property "other"']);
        // a property is checked against both its own schema and every pattern it matches
        const both = { type: 'object', properties: { 'x-id': { type: 'string' } }, patternProperties: { '^x-': { enum: ['a', 'b'] } } };
        assert.deepStrictEqual(validateArguments(both, { 'x-id': 'c' }), ['property "x-id" must be one of a, b']);
        // with a pattern that is not a regular expression, there is no telling which properties are additional
        assert.deepStrictEqual(validateArguments({ type: 'object', patternProperties: { '(': {} }, additionalProperties: false }, { any: 1 }), []);
    });

    it('should accept anything without a schema, and ignore keywords it does not support', function() {
        assert.deepStrictEqual(validateArguments(undefined, { a: 1 }), []);
        assert.deepStrictEqual(validateArguments({ type: 'object', properties: { n: { type: 'number', minimum: 10 } } }, { n: 1 }), []);
        assert.deepStrictEqual(validateArguments({ type: 'object', properties: { d: { type: 'date' } } }, { d: 'today' }), []);
    });
});
