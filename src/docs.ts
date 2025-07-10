import { z } from 'zod/v4';
import yaml from 'yaml';
import { OpenApiGeneratorV3, OpenAPIRegistry, extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { getUserModuleNames, fetchModule, Entity, Event } from 'agentlang/out/runtime/module.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

extendZodWithOpenApi(z);

const registry = new OpenAPIRegistry();

const bearerAuth = registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
});

function getOpenApiDocumentation(registry: OpenAPIRegistry, name: string, version: string) {
  const generator = new OpenApiGeneratorV3(registry.definitions);

  return generator.generateDocument({
    openapi: '3.0.0',
    info: {
      version: version,
      title: name,
      description: 'This is the API',
    },
    servers: [{ url: 'v1' }],
  });
}

function writeDocumentation(registry: OpenAPIRegistry, docDir: string, name: string, version: string) {
  const docs = getOpenApiDocumentation(registry, name, version);
  const fileContent = yaml.stringify(docs);
  fs.mkdir(path.join(docDir, 'docs'), { recursive: true });
  fs.writeFile(`${docDir}/docs/openapi-docs.yml`, fileContent, {
    encoding: 'utf-8'});
}


function findRelationshipPaths(moduleName: string, entityName: string): string[][] {
    const module = fetchModule(moduleName);
    const relationships = module.getContainsRelationshipEntries();

    function findPathsRecursive(currentEntity: string, visited: Set<string>, currentPath: string[]): string[][] {
        const matchingRels = relationships.filter(rel => rel.node2.origName === currentEntity);
        if (matchingRels.length === 0) {
            return currentPath.length > 0 ? [currentPath] : [];
        }
        let allPaths: string[][] = [];
        for (const rel of matchingRels) {
            const node1Entity = rel.node1.origName;
            
            if (visited.has(node1Entity)) {
                continue;
            }
            const newVisited = new Set(visited);
            newVisited.add(node1Entity);
            const newPath = [...currentPath, rel.name, "{" + node1Entity.toLowerCase() + "}", node1Entity];
            const paths = findPathsRecursive(node1Entity, newVisited, newPath);
            allPaths = allPaths.concat(paths);
        }

        return allPaths;
    }

    const visited = new Set<string>([entityName]);
    return findPathsRecursive(entityName, visited, [entityName]);
}

function createZodSchemaFromEntitySchema(schema: Map<string, any>) {
  return z.object(
    Object.fromEntries(
      Array.from(schema.entries()).map(([key, value]) => [
        key,
        value.type === 'UUID' ? z.uuid() :
        value.type === 'String' ? z.string() :
        value.type === 'Int' ? z.number() :
        value.type === 'Float' ? z.number() :
        value.type === 'Boolean' ? z.boolean() :
        value.type === 'Date' ? z.string() :
        value.type === 'DateTime' ? z.string() :
        z.any()
      ])
    )
  );
}

function createResponseSchemas(entitySchema: any, entityPath: string) {
  const requestSchema = z.object({
    [entityPath]: entitySchema
  });
  const responseSchema = z.array(entitySchema);
  
  return { requestSchema, responseSchema };
}

function registerEntityEndpoint(
  method: 'get' | 'post' | 'put' | 'delete',
  path: string,
  tags: string[],
  entityPath: string,
  entitySchema: any,
  requestSchema?: any
) {
  const endpointConfig: any = {
    method,
    path,
    security: [{ [bearerAuth.name]: [] }],
    tags: tags,
    responses: {
      200: {
        description: 'Success',
        content: {
          'application/json': {
            schema: method === 'get' ? z.array(entitySchema) : entitySchema
          }
        }
      },
      404: {
        description: 'Not Found'
      },
      500: {
        description: 'Internal Server Error'
      }
    }
  };

  if (method === 'post' || method === 'put') {
    endpointConfig.request = {
      body: {
        content: {
          'application/json': {
            schema: requestSchema
          }
        }
      }
    };
  }

  if (method === 'put' || method === 'delete') {
    endpointConfig.parameters = [{
      name: 'id',
      in: 'path',
      required: true,
      schema: { type: 'string' }
    }];
  }

  if (method === 'post') {
    delete endpointConfig.responses[404];
  }

  registry.registerPath(endpointConfig);
}

function generateEntitiesEntries() {
  const modules = getUserModuleNames();
  
  return modules.map((moduleName: string) => {
    const module = fetchModule(moduleName);
    const entities = module.getEntityEntries();
    
    return entities.map((entity: Entity) => {
      const entityPath = `${moduleName}/${entity.name}`;
      
      const relatinotionshipPaths = findRelationshipPaths(moduleName, entity.name);
      
      const entitySchema = createZodSchemaFromEntitySchema(entity.schema)
        .openapi(`${entity.name}Schema`);
      
      const { requestSchema } = createResponseSchemas(entitySchema, entityPath);
      
      registerEntityEndpoint('post', `/api/${entityPath}`, [entityPath], entityPath, entitySchema, requestSchema);
      registerEntityEndpoint('get', `/api/${entityPath}`, [entityPath], entityPath, entitySchema);
      registerEntityEndpoint('put', `/api/${entityPath}/{id}`, [entityPath], entityPath, entitySchema, requestSchema);
      registerEntityEndpoint('delete', `/api/${entityPath}/{id}`, [entityPath], entityPath, entitySchema);

      if (relatinotionshipPaths.length > 1) {
        relatinotionshipPaths.forEach((path) => {
          const relationshipPath = path.reverse().join('/');
          registerEntityEndpoint('post', `/api/${relationshipPath}`, [entityPath + " (" + path[path.length - 2] + ")"], relationshipPath, entitySchema, requestSchema);
          registerEntityEndpoint('get', `/api/${relationshipPath}`, [entityPath + " (" + path[path.length - 2] + ")"], relationshipPath, entitySchema);
          registerEntityEndpoint('put', `/api/${relationshipPath}/{id}`, [entityPath + " (" + path[path.length - 2] + ")"], relationshipPath, entitySchema, requestSchema);
          registerEntityEndpoint('delete', `/api/${relationshipPath}/{id}`, [entityPath + " (" + path[path.length - 2] + ")"], relationshipPath, entitySchema);
        });
      }
    });
  });
}

function generateEventsEntries() {
  const modules = getUserModuleNames();
  return modules.map((moduleName: string) => {
    const module = fetchModule(moduleName);
    const events = module.getEventEntries();
    return events.map((event: Event) => {
      const eventPath = `${moduleName}/${event.name}`;
      
      const eventSchema = z.object(Object.fromEntries(Array.from(event.schema.entries()).map(([key, value]) => [
        key,
        value.type === 'UUID' ? z.uuid() :
            value.type === 'String' ? z.string() :
            value.type === 'Int' ? z.number() :
            value.type === 'Float' ? z.number() :
            value.type === 'Boolean' ? z.boolean() :
            value.type === 'Date' ? z.string() :
            value.type === 'DateTime' ? z.string() :
            z.any()
      ]))).openapi(`${event.name}Schema`);

      const sc = z.object({
        [eventPath]: eventSchema
    });

      registry.registerPath({
        method: 'post',
        path: `/api/${eventPath}`,
        security: [{ [bearerAuth.name]: [] }],
        tags: ['Events'],
        request: {
          body: {
            content: {
              'application/json': {
                schema: sc
              }
            }
          }
        },
        responses: {
          200: {
            description: 'Success'
          },
          404: {
            description: 'Not Found'
          },
          500: {
            description: 'Internal Server Error'
          }
        }
      });

      return {
        path: eventPath,
        name: event.name,
        schema: event.schema
      };
    });
  });
}

export const generateSwaggerDoc = async (fileName: string): Promise<void> => {
  console.log('Generating documentation...');
  const docDir =
    path.dirname(fileName) === '.' ? process.cwd() : path.resolve(process.cwd(), fileName);
  
    const packagePath = path.join(docDir, 'package.json');
    const packageContent = await fs.readFile(packagePath, 'utf-8');
    const pkg = JSON.parse(packageContent);
    const name = pkg.name || 'app';
    const version = pkg.version || '0.0.1';

  generateEntitiesEntries();
  generateEventsEntries();

  writeDocumentation(registry, docDir, name, version);
}; 