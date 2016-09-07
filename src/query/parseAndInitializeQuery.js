import {FRAGMENT_SPREAD, INLINE_FRAGMENT} from 'graphql/language/kinds';
import {
  convertFragmentToInline,
  CACHED,
  parse,
  clone,
  ensureRootType,
  TYPENAME,
  teardownDocumentAST,
  getFieldSchema,
  makeCachedArgs
} from '../utils';
import {TypeKind} from 'graphql/type/introspection';
import {Field} from '../helperClasses';

const {UNION} = TypeKind;

const validateCachedDirective = (cachedDirective, schema) => {
  const cachedDirectiveArgs = makeCachedArgs(cachedDirective.arguments);
  if (cachedDirectiveArgs.id && cachedDirectiveArgs.ids) {
    throw new Error(`@entity can receive either an 'id' or 'ids' arg, not both`);
  }

  if (!cachedDirectiveArgs.type) {
    throw new Error(`@entity requires a type arg.`);
  }
  const typeValue = cachedDirectiveArgs.type.value;
  const typeSchema = schema.types[typeValue.value];
  if (!typeSchema) {
    throw new Error(`Cannot find type ${typeValue.value} in your schema!`);
  }
  // TODO properly initialize unions?
};

export default function parseAndInitializeQuery(queryString, schema, idFieldName) {
  const ast = parse(queryString);
  const {operation, fragments} = teardownDocumentAST(ast.definitions);
  const catalogFields = [idFieldName, TYPENAME];
  const initializeQueryAST = (fields, parentSchema) => {
    for (let i = 0; i < fields.length; i++) {
      // convert fragment spreads into inline so we can minimize queries later
      let field = fields[i];
      if (field.kind === FRAGMENT_SPREAD) {
        const fragment = clone(fragments[field.name.value]);
        field = fields[i] = convertFragmentToInline(fragment);
      }
      // if it's an inline fragment, set schema to the typecondition, or parentSchema if null
      if (field.kind === INLINE_FRAGMENT) {
        const subSchema = field.typeCondition ? schema.types[field.typeCondition.name.value] : parentSchema;
        const children = field.selectionSet.selections;
        for (let fieldToRemove of catalogFields) {
          const idx = children.findIndex(child => child.name && child.name.value === fieldToRemove);
          if (idx !== -1) {
            children.splice(idx, 1);
          }
        }
        initializeQueryAST(children, subSchema);
        continue;
      }
      // sort args once here to make sure the key is the same in the store w/o sorting later
      if (field.arguments && field.arguments.length) {
        field.arguments.sort((a, b) => a.name.value > b.name.value);
      }
      const cachedDirective = field.directives && field.directives.find(d => d.name.value === CACHED);
      if (field.selectionSet) {
        const children = field.selectionSet.selections;
        // if no resolve function is present, then it might just be a sort or filter
        if (cachedDirective) {
          validateCachedDirective(cachedDirective, schema);
        } else {
          const fieldSchema = getFieldSchema(field, parentSchema, schema);
          const rootFieldSchema = ensureRootType(fieldSchema.type);
          const typeSchema = schema.types[rootFieldSchema.name];
          const fieldsToAdd = typeSchema.kind === UNION ? catalogFields : typeSchema.fields[idFieldName] ? [idFieldName] : [];
          for (let fieldToAdd of fieldsToAdd) {
            const child = children.find(child => child.name && child.name.value === fieldToAdd);
            if (!child) {
              children.push(new Field({name: fieldToAdd}))
            }
          }
          initializeQueryAST(children, typeSchema);
        }
      }
      else if (cachedDirective) {
        throw new Error(`@entity can only be applied to an object or array`);
      }
    }
  };
  initializeQueryAST(operation.selectionSet.selections, schema.querySchema);
  ast.definitions = [operation];
  return ast;
};

