/**
 * @module botbuilder-adapter-mcp
 */
/**
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

/**
 * True for a non-null object that is not an array.
 * @ignore
 */
export function isPlainObject(value: any): boolean {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
