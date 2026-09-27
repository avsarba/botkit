/**
 * @module botbuilder-adapter-mcp
 */
/**
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { isPlainObject } from './util';

/**
 * How deep validateArguments() follows nested `properties` and `items` schemas.
 */
const MAX_DEPTH = 16;

/**
 * Test a value against one JSON Schema type name. Unknown type names accept any value.
 */
function hasType(value: any, type: string): boolean {
    switch (type) {
    case 'string':
        return typeof value === 'string';
    case 'number':
        return typeof value === 'number' && isFinite(value);
    case 'integer':
        return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
        return typeof value === 'boolean';
    case 'object':
        return isPlainObject(value);
    case 'array':
        return Array.isArray(value);
    case 'null':
        return value === null;
    default:
        return true;
    }
}

/**
 * Show an enum value in a problem message: strings as they are, anything else as JSON.
 */
function showValue(value: any): string {
    return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * Deep equality for JSON values, used by `enum`.
 */
function jsonEqual(a: any, b: any): boolean {
    if (a === b) {
        return true;
    }
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) {
        return false;
    }
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    return keysA.length === keysB.length && keysA.every((key) => Object.prototype.hasOwnProperty.call(b, key) && jsonEqual(a[key], b[key]));
}

/**
 * Check one value against a schema and add any problems to `problems`.
 * @param label How the value is named in messages, such as `property "size"` or `arguments`.
 * @param path The dotted path of the value, used to name nested properties. Empty for the arguments object itself.
 */
function check(schema: any, value: any, label: string, path: string, problems: string[], depth: number): void {
    if (!isPlainObject(schema) || depth > MAX_DEPTH) {
        return;
    }

    if (schema.type !== undefined) {
        const types: string[] = (Array.isArray(schema.type) ? schema.type : [schema.type]).map(String);
        if (!types.some((type) => hasType(value, type))) {
            problems.push(`${ label } must be ${ types.join(' or ') }`);
            return;
        }
    }

    if (Array.isArray(schema.enum) && !schema.enum.some((option) => jsonEqual(option, value))) {
        problems.push(`${ label } must be one of ${ schema.enum.map(showValue).join(', ') }`);
        return;
    }

    const child = (key: string): string => path ? `${ path }.${ key }` : key;

    if (isPlainObject(value)) {
        const properties = isPlainObject(schema.properties) ? schema.properties : {};
        if (Array.isArray(schema.required)) {
            schema.required.forEach((key) => {
                if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined) {
                    problems.push(`missing required property "${ child(String(key)) }"`);
                }
            });
        }
        Object.keys(value).forEach((key) => {
            if (value[key] === undefined) {
                return;
            }
            if (Object.prototype.hasOwnProperty.call(properties, key)) {
                check(properties[key], value[key], `property "${ child(key) }"`, child(key), problems, depth + 1);
            } else if (schema.additionalProperties === false) {
                problems.push(`unexpected property "${ child(key) }"`);
            } else if (isPlainObject(schema.additionalProperties)) {
                check(schema.additionalProperties, value[key], `property "${ child(key) }"`, child(key), problems, depth + 1);
            }
        });
    }

    if (Array.isArray(value) && isPlainObject(schema.items)) {
        value.forEach((item, index) => {
            const itemPath = `${ path || 'arguments' }[${ index }]`;
            check(schema.items, item, `property "${ itemPath }"`, itemPath, problems, depth + 1);
        });
    }
}

/**
 * Check tool arguments against a JSON Schema and describe every problem in plain words, so an agent can fix its call.
 * This is the subset of JSON Schema that tool arguments need:
 *
 * * `type`: `string`, `number`, `integer`, `boolean`, `object`, `array`, `null`, or an array of these;
 * * `enum`;
 * * `required`, `properties` and `additionalProperties` (`false`, or a schema for the extra properties), for nested objects too;
 * * `items` (a single schema) for arrays.
 *
 * Other keywords, such as `minimum`, `pattern` or `oneOf`, are not checked: validate those in the tool's handler.
 *
 * ```javascript
 * const { validateArguments } = require('botbuilder-adapter-mcp');
 * const schema = {
 *     type: 'object',
 *     properties: { size: { type: 'string', enum: ['small', 'large'] } },
 *     required: ['size'],
 *     additionalProperties: false
 * };
 * validateArguments(schema, { size: 'large' }); // []
 * validateArguments(schema, { size: 'huge', extra: 1 });
 * // ['property "size" must be one of small, large', 'unexpected property "extra"']
 * ```
 *
 * @param schema A JSON Schema, usually a tool's `inputSchema`.
 * @param args The arguments to check.
 * @returns A list of problems, such as `missing required property "size"`, or an empty array when the arguments are valid.
 */
export function validateArguments(schema: any, args: any): string[] {
    const problems: string[] = [];
    check(schema, args, 'arguments', '', problems, 0);
    return problems;
}
