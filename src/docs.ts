import { z } from 'zod/v4';
import yaml from 'yaml';
import { OpenApiGeneratorV3, OpenAPIRegistry, extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { getUserModuleNames, fetchModule, Entity, Event } from 'agentlang/out/runtime/module.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import Converter from 'openapi-to-postmanv2';
import { execSync } from 'child_process';

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
  fs.writeFile(`${docDir}/docs/openapi.yml`, fileContent, {
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

function getOneOfValues(properties: Map<string, any>): string[] {
  const oneOf = properties.get('one-of') || new Set<string>();
  return Array.from(oneOf);
}

function createZodSchemaFromEntitySchema(schema: Map<string, any>) {
  return z.object(
    Object.fromEntries(
      Array.from(schema.entries()).map(([key, value]) => {
        const k = key
        let v : any = value.properties && value.properties.get('one-of') ? z.enum(getOneOfValues(value.properties)) :
        value.type === 'String' ? z.string() :
        value.type === 'Int' ? z.number() :
        value.type === 'Number' ? z.boolean() :
        value.type === 'Email' ? z.string() :
        value.type === 'Date' ? z.string() :
        value.type === 'Time' ? z.string() :
        value.type === 'DateTime' ? z.string() :
        value.type === 'Boolean' ? z.boolean() :
        value.type === 'UUID' ? z.uuid() :
        value.type === 'URL' ? z.string() :
        value.type === 'Path' ? z.string() :
        value.type === 'Map' ? z.object() :
        value.type === 'Any' ? z.any() :
        z.any()

        if (value.properties && value.properties.get('optional')) {
          v = v.optional()
        }
        if (value.properties && value.properties.get('default')) {
          const deflt = value.properties.get('default')
          switch (deflt) {
            case 'uuid()':
              z.uuid().optional()
              break
            case 'now()':
              v = z.date().optional()
              break
            default:
              v = v.default(deflt)
          }
        }
        return [k, v]
      })
    )
  );
}

function registerEntityEndpoint(
  method: 'get' | 'post' | 'put' | 'delete',
  path: string,
  tags: string[],
  filterPaths: string[],
  entitySchema: any
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
            schema: entitySchema
          }
        }
      }
    };
  }

  endpointConfig.parameters = filterPaths.map((path) => { 
    return {
      name: path,
      in: 'path',
      required: true,
      schema: { type: 'string' }
    }
  });

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
            
      registerEntityEndpoint('post', `/${entityPath}`, [entity.name], [], entitySchema);
      registerEntityEndpoint('get', `/${entityPath}`, [entity.name], [], entitySchema);
      registerEntityEndpoint('put', `/${entityPath}/{id}`, [entity.name], ["id"], entitySchema);
      registerEntityEndpoint('delete', `/${entityPath}/{id}`, [entity.name], ["id"], entitySchema);

      if (relatinotionshipPaths.length > 1) {
        relatinotionshipPaths.forEach((path) => {
          const relationshipPath = path.reverse().join('/');
          const filterPaths = path.filter(segment => segment.startsWith('{') && segment.endsWith('}')).map(segment => segment.slice(1, -1))
          registerEntityEndpoint('post', `/${relationshipPath}`, [entity.name + " (" + path[path.length - 2] + ")"], filterPaths, entitySchema);
          registerEntityEndpoint('get', `/${relationshipPath}`, [entity.name + " (" + path[path.length - 2] + ")"], filterPaths, entitySchema);
          registerEntityEndpoint('put', `/${relationshipPath}/{id}`, [entity.name + " (" + path[path.length - 2] + ")"], filterPaths.concat(["id"]), entitySchema);
          registerEntityEndpoint('delete', `/${relationshipPath}/{id}`, [entity.name + " (" + path[path.length - 2] + ")"], filterPaths.concat(["id"]), entitySchema);
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
      
      const eventSchema = createZodSchemaFromEntitySchema(event.schema).openapi(`${event.name}Schema`);

      const sc = z.object({
        [eventPath]: eventSchema
    });

      registry.registerPath({
        method: 'post',
        path: `/${eventPath}`,
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

export const generateSwaggerDoc = async (fileName: string, options?: { outputHtml?: boolean; outputPostman?: boolean }): Promise<void> => {
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

  if (options?.outputHtml) {
    await generateHtmlDocumentation(registry, docDir, name, version);
  }

  if (options?.outputPostman) {
    await generatePostmanCollection(registry, docDir, name, version);
  }
};

async function generateHtmlDocumentation(registry: OpenAPIRegistry, docDir: string, name: string, version: string): Promise<void> {
  const outputPath = `${docDir}/docs/index.html`;

  const yamlContent = await fs.readFile(`${docDir}/docs/openapi.yml`, 'utf8');
  const jsonContent = JSON.stringify(yaml.parse(yamlContent), null, 2);
  await fs.writeFile(`${docDir}/docs/openapi.json`, jsonContent, { encoding: 'utf-8' });
  console.log('OpenAPI JSON generated: docs/openapi.json');

  try {
    execSync(`redocly build-docs ${docDir}/docs/openapi.json -o ${outputPath}`);
    console.log('HTML documentation generated: docs/index.html');
  } catch (error) {
    console.error('Failed to generate HTML documentation:', error);
  }
}

async function generatePostmanCollection(registry: OpenAPIRegistry, docDir: string, name: string, version: string): Promise<void> {
  const openapiData = await fs.readFile(`${docDir}/docs/openapi.yml`, 'utf8');

  Converter.convert({ type: 'string', data: openapiData },
    {}, (err: any, conversionResult: any) => {
      if (!conversionResult.result) {
        console.log('Could not convert', conversionResult.reason);
      }
      else {
        const collection = conversionResult.output[0].data;
        fs.writeFile(`${docDir}/docs/postman.json`, JSON.stringify(collection, null, 2), { encoding: 'utf-8' });
        console.log('Postman collection generated: docs/postman.json');
      }
  }
  );
}
