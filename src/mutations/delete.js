/* @flow */
import deepcopy from 'deepcopy'

import type {
  ClientTypes,
  SchemaType
} from '../utils/definitions.js'

import {
  isScalar
} from '../utils/graphql.js'

import {
  GraphQLNonNull,
  GraphQLID,
  GraphQLObjectType
} from 'graphql'

import {
  mutationWithClientMutationId,
  toGlobalId
} from 'graphql-relay'

import simpleMutation from './simpleMutation.js'

import {
  getFieldNameFromModelName,
  convertInputFieldsToInternalIds,
  convertIdToExternal } from '../utils/graphql.js'

export default function (
  viewerType: GraphQLObjectType, clientTypes: ClientTypes, modelName: string, schemaType: SchemaType
  ): GraphQLObjectType {
  const config = {
    name: `Delete${modelName}`,
    outputFields: {
      [getFieldNameFromModelName(modelName)]: {
        type: clientTypes[modelName].objectType
      },
      deletedId: {
        type: new GraphQLNonNull(GraphQLID)
      },
      viewer: {
        type: viewerType,
        resolve: (_, args, { rootValue: { backend } }) => (
          backend.user()
        )
      }
    },
    inputFields: {
      id: {
        type: new GraphQLNonNull(GraphQLID)
      }
    },
    mutateAndGetPayload: (args, { rootValue: { currentUser, backend, webhooksProcessor } }) => {
      const node = convertInputFieldsToInternalIds(args, clientTypes[modelName].clientSchema)

      function getBackRelationNodes (relationField, nodeToDelete) {
        if (relationField.isList) {
          return backend.allNodesByRelation(
            modelName,
            nodeToDelete.id,
            relationField.fieldName,
            null,
            clientTypes[modelName].clientSchema,
            currentUser)
          .then((nodes) => nodes.filter((node) => node !== null))
        } else {
          if (!nodeToDelete[`${relationField.fieldName}Id`]) {
            return Promise.resolve([])
          }
          return backend.node(
            relationField.typeIdentifier,
            nodeToDelete[`${relationField.fieldName}Id`],
            clientTypes[relationField.typeIdentifier].clientSchema,
            currentUser).then((node) => node ? [node] : [])
        }
      }

      // todo: this disregards isRequired=true on related node
      function setInlinedBackRelationsToNull (nodeToDelete) {
        const relationFields = clientTypes[modelName].clientSchema.fields
          .filter((field) => field.backRelationName)

        if (relationFields.length === 0) {
          return Promise.resolve()
        }

        return Promise.all(relationFields.map((field) =>
          getBackRelationNodes(field, nodeToDelete)
            .then((relationNodes) => {
              return Promise.all(relationNodes.map((relationNode) => {
                relationNode[`${field.backRelationName}Id`] = null
                return backend.updateNode(
                  field.typeIdentifier,
                  relationNode.id,
                  relationNode,
                  clientTypes[field.typeIdentifier].clientSchema,
                  currentUser)
              }))
            })))
      }

      return backend.node(
          modelName,
          node.id,
          clientTypes[modelName].clientSchema,
          currentUser)
        .then((nodeToDelete) => {
          if (nodeToDelete === null) {
            return Promise.reject(`'${modelName}' with id '${node.id}' does not exist`)
          }
          
          return backend.deleteNode(modelName, node.id, clientTypes[modelName].clientSchema, currentUser)
            .then((node) => {
              webhooksProcessor.nodeDeleted(convertIdToExternal(modelName, node), modelName)
              return node
            })
            .then((node) => ({[getFieldNameFromModelName(modelName)]: node, deletedId: args.id}))
        })
    }
  }

  if (schemaType === 'SIMPLE') {
    return simpleMutation(config,
      clientTypes[modelName].objectType,
      (root) => root[getFieldNameFromModelName(modelName)])
  } else {
    return mutationWithClientMutationId(config)
  }
}
