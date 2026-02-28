import { Box, Text } from 'ink';

interface HelpProps {
  version: string;
}

function Separator() {
  return <Text dimColor>{'─'.repeat(56)}</Text>;
}

function SectionTitle({ title }: { title: string }) {
  return (
    <Box marginBottom={1}>
      <Text bold color="white">
        {title}
      </Text>
    </Box>
  );
}

function Command({ name, args, description }: { name: string; args?: string; description: string }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        {'  '}
        <Text color="cyan" bold>
          {name}
        </Text>
        {args && <Text dimColor> {args}</Text>}
      </Text>
      <Text dimColor>{'    '}{description}</Text>
    </Box>
  );
}

function Option({ flag, arg, desc }: { flag: string; arg?: string; desc: string }) {
  return (
    <Text>
      {'      '}
      <Text color="cyan">{flag}</Text>
      {arg && <Text dimColor> {arg}</Text>}
      {'  '}
      <Text dimColor>{desc}</Text>
    </Text>
  );
}

function SubOptions({ children }: { children: React.ReactNode }) {
  return (
    <Box flexDirection="column" marginLeft={2} marginBottom={1}>
      <Text color="yellow">{'  OPTIONS'}</Text>
      {children}
    </Box>
  );
}

export default function Help({ version }: HelpProps) {
  const g0 = '#00D9FF';
  const g1 = '#00C4E6';
  const g2 = '#00AFCC';
  const g3 = '#009AB3';

  return (
    <Box flexDirection="column">
      {/* ASCII Art Header — wrapped in a rounded cyan border */}
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="cyan"
        paddingX={2}
        paddingY={1}
        marginBottom={1}
      >
        <Text>
          <Text color={g0}>{'█████╗ '}</Text>
          <Text color={g1}>{' ██████╗ '}</Text>
          <Text color={g2}>{'███████╗'}</Text>
          <Text color={g3}>{'███╗   ██╗'}</Text>
          <Text color={g0}>{'████████╗'}</Text>
        </Text>
        <Text>
          <Text color={g0}>{'██╔══██╗'}</Text>
          <Text color={g1}>{'██╔════╝ '}</Text>
          <Text color={g2}>{'██╔════╝'}</Text>
          <Text color={g3}>{'████╗  ██║'}</Text>
          <Text color={g0}>{'╚══██╔══╝'}</Text>
        </Text>
        <Text>
          <Text color={g0}>{'███████║'}</Text>
          <Text color={g1}>{'██║  ███╗'}</Text>
          <Text color={g2}>{'█████╗  '}</Text>
          <Text color={g3}>{'██╔██╗ ██║'}</Text>
          <Text color={g0}>{'   ██║'}</Text>
        </Text>
        <Text>
          <Text color={g0}>{'██╔══██║'}</Text>
          <Text color={g1}>{'██║   ██║'}</Text>
          <Text color={g2}>{'██╔══╝  '}</Text>
          <Text color={g3}>{'██║╚██╗██║'}</Text>
          <Text color={g0}>{'   ██║'}</Text>
        </Text>
        <Text>
          <Text color={g0}>{'██║  ██║'}</Text>
          <Text color={g1}>{'╚██████╔╝'}</Text>
          <Text color={g2}>{'███████╗'}</Text>
          <Text color={g3}>{'██║ ╚████║'}</Text>
          <Text color={g0}>{'   ██║'}</Text>
        </Text>
        <Text>
          <Text color={g0}>{'╚═╝  ╚═╝ '}</Text>
          <Text color={g1}>{' ╚═════╝ '}</Text>
          <Text color={g2}>{'╚══════╝'}</Text>
          <Text color={g3}>{'╚═╝  ╚═══╝'}</Text>
          <Text color={g0}>{'   ╚═╝'}</Text>
        </Text>
        <Text> </Text>
        <Text>
          <Text bold color="white">Agentlang CLI</Text>
          {'  '}
          <Text dimColor>v{version}</Text>
        </Text>
        <Text dimColor>CLI for all things Agentlang</Text>
      </Box>

      {/* Usage */}
      <Box flexDirection="column" marginLeft={2} marginBottom={1}>
        <SectionTitle title="USAGE" />
        <Separator />
        <Box marginTop={1} marginLeft={2}>
          <Text>
            <Text dimColor>$ </Text>
            <Text color="cyan">agent</Text>
            {' '}
            <Text color="yellow">{'<command>'}</Text>
            {' '}
            <Text dimColor>[options]</Text>
          </Text>
        </Box>
      </Box>

      {/* Commands */}
      <Box flexDirection="column" marginLeft={2} marginBottom={1}>
        <SectionTitle title="COMMANDS" />
        <Separator />
        <Box flexDirection="column" marginTop={1}>
          <Command name="init" args="<appname>" description="Initialize a new Agentlang application" />
          <SubOptions>
            <Option flag="-p, --prompt" arg="<description>" desc="Description or prompt for the application" />
          </SubOptions>

          <Command name="run" args="[file]" description="Load and execute an Agentlang module" />
          <SubOptions>
            <Option flag="-c, --config" arg="<file>" desc="Configuration file path" />
          </SubOptions>

          <Command name="repl" args="[directory]" description="Start interactive REPL environment" />
          <SubOptions>
            <Option flag="-w, --watch" desc="Watch files and reload automatically" />
            <Option flag="-q, --quiet" desc="Suppress startup messages" />
          </SubOptions>

          <Command name="doc" args="[file]" description="Generate API documentation (Swagger/OpenAPI)" />
          <SubOptions>
            <Option flag="-h, --outputHtml" arg="<file>" desc="Generate HTML documentation" />
            <Option flag="-p, --outputPostman" arg="<file>" desc="Generate Postman collection" />
          </SubOptions>

          <Command name="parseAndValidate" args="<file>" description="Parse and validate Agentlang source code" />
          <SubOptions>
            <Option flag="-d, --destination" arg="<dir>" desc="Output directory" />
          </SubOptions>

          <Command
            name="ui-gen"
            args="[spec-file]"
            description="Generate UI from specification (requires Anthropic API key)"
          />
          <SubOptions>
            <Option flag="-d, --directory" arg="<dir>" desc="Target directory" />
            <Option flag="-k, --api-key" arg="<key>" desc="Anthropic API key" />
            <Option flag="-p, --push" desc="Commit and push to git" />
            <Option flag="-m, --message" arg="<text>" desc="Update instructions" />
          </SubOptions>

          <Command name="fork" args="<source> [name]" description="Fork an app from a local directory or git repository" />
          <SubOptions>
            <Option flag="-b, --branch" arg="<branch>" desc="Git branch to clone (for git URLs)" />
            <Option flag="-u, --username" arg="<username>" desc="GitHub username for authenticated access" />
            <Option flag="-t, --token" arg="<token>" desc="GitHub token for authenticated access" />
          </SubOptions>

          <Command name="import" args="<source> [name]" description="Import an app (alias for fork)" />
          <SubOptions>
            <Option flag="-b, --branch" arg="<branch>" desc="Git branch to clone (for git URLs)" />
            <Option flag="-u, --username" arg="<username>" desc="GitHub username for authenticated access" />
            <Option flag="-t, --token" arg="<token>" desc="GitHub token for authenticated access" />
          </SubOptions>

          <Command name="studio" args="[path]" description="Start Agentlang Studio with local server" />
          <SubOptions>
            <Option flag="-p, --port" arg="<port>" desc="Port to run Studio server on (default: 4000)" />
          </SubOptions>
        </Box>
      </Box>

      {/* Global Options */}
      <Box flexDirection="column" marginLeft={2} marginBottom={1}>
        <SectionTitle title="GLOBAL OPTIONS" />
        <Separator />
        <Box flexDirection="column" marginTop={1} marginLeft={2}>
          <Text>
            <Text color="cyan">-h, --help</Text>
            {'      '}
            <Text dimColor>Display help information</Text>
          </Text>
          <Text>
            <Text color="cyan">-V, --version</Text>
            {'  '}
            <Text dimColor>Display version number</Text>
          </Text>
        </Box>
      </Box>

      {/* Learn More */}
      <Box flexDirection="column" marginLeft={2} marginBottom={1}>
        <SectionTitle title="LEARN MORE" />
        <Separator />
        <Box flexDirection="column" marginTop={1} marginLeft={2}>
          <Text>
            <Text color="white">Docs</Text>
            {'      '}
            <Text color="cyan">https://github.com/agentlang/agentlang-cli</Text>
          </Text>
          <Text>
            <Text color="white">Issues</Text>
            {'    '}
            <Text color="cyan">https://github.com/agentlang/agentlang-cli/issues</Text>
          </Text>
        </Box>
      </Box>

      <Box marginLeft={4} marginBottom={1}>
        <Text dimColor>
          {'Run '}
          <Text color="cyan">agent {'<command>'} --help</Text>
          {' for detailed command information'}
        </Text>
      </Box>
    </Box>
  );
}
