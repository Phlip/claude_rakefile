

  #  a Rakefile is a command line aggregator

  # .---.
  #               /  .-.  \
  #              /  /   \  \
  #             /  /  .-.|  |
  #            |  |  /  ||  |
  #       /\   |  | |   '|  |
  #      /  \  |  |  \___|  |   /\
  #     / /\ \ |  |    .-.  |  /  \
  #    | |  \ \|  |   /   \ | / /\ \
  #    | |   \ '  |  /     \|/ /  | |
  #     \ \   \   | /   /\    /  / /
  #      \ \   |  |/   /  \  /  / /
  #       \ \  |  |   |    \/  / /
  #        \ \/   /    \      / /
  #         \____/      \____/
  #
  #   _   _ _   _ ____  _____    _    _
  #  | | | | \ | |  _ \|  ___|  / \  | |
  #  | | | |  \| | |_) | |_    / _ \ | |
  #  | |_| | |\  |  _ <|  _|  / ___ \| |___
  #   \___/|_| \_|_| \_\_|   /_/   \_\_____|
  #
  #  _____ ____  _   _ ____  _   _    _    __  __ _____ _  _ _____
  # |_   _/ __ \| | | |  _ \| \ | |  / \  |  \/  | ____| \| |_   _|
  #   | || |  | | | | | |_) |  \| | / _ \ | |\/| |  _| | .` | | |
  #   | || |__| | |_| |  _ <| |\  |/ ___ \| |  | | |___| |\  | | |
  #   |_| \____/ \___/|_| \_|_| \_/_/   \_\_|  |_|_____|_| \_| |_|


require 'fileutils'
require 'digest'
require 'shellwords'

# TODO  ask mr machine to write a task that opens a Rakefile in the target vicinity

ANTHROPIC_API_KEY = ENV['ANTHROPIC_API_KEY']
ANTHROPIC_BASE_URL = ENV['ANTHROPIC_BASE_URL'] || 'https://app-llmproxy.surgehq.ai/api/llm_proxy/anthropic'
ANTHROPIC_USER_ID = ENV['ANTHROPIC_USER_ID']

namespace :claude do
  desc "Run claude on a target path using CLAUDE.md guidelines (invokes the actual CLI binary name, `claude`)"
  task :run, [:path] do |_t, args|
    target_path = File.expand_path(args[:path] || '.')
    claude_md = File.join(target_path, 'CLAUDE.md')

    raise "Missing CLAUDE.md at: #{claude_md}" unless File.exist?(claude_md)
    raise "Missing ANTHROPIC_API_KEY" if ANTHROPIC_API_KEY.nil? || ANTHROPIC_API_KEY.empty?

    env = {
      'ANTHROPIC_API_KEY' => ANTHROPIC_API_KEY,
      'ANTHROPIC_BASE_URL' => ANTHROPIC_BASE_URL,
      'ANTHROPIC_USER_ID' => ANTHROPIC_USER_ID
    }.compact

    # Invokes claude within the context directory of the targeted CLAUDE.md
    system(env, 'claude', chdir: target_path) || raise("claude execution failed")
  end

  CLAUDE_IMAGE = 'claude-sandbox'

  desc 'Run Claude Code in a Docker container on a target path (interactive, or headless with a prompt)'
  task :docker, [:path, :prompt] do |_t, args|
    target_path = File.expand_path(args[:path] || '.')
    raise "No such directory: #{target_path}" unless Dir.exist?(target_path)
    raise "Missing ANTHROPIC_API_KEY" if ANTHROPIC_API_KEY.nil? || ANTHROPIC_API_KEY.empty?

    # Built from stdin so no Dockerfile lands in the target; the node image's
    # `node` user is uid 1000, which matches the usual host user for the mount
    dockerfile = <<~DOCKER
      FROM node:20-bookworm
      RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep \\
       && rm -rf /var/lib/apt/lists/*
      RUN npm install -g @anthropic-ai/claude-code
      USER node
      WORKDIR /workspace
    DOCKER
    IO.popen(['docker', 'build', '-t', CLAUDE_IMAGE, '-'], 'w') { |io| io.write(dockerfile) }
    raise 'docker build failed' unless $?.success?
    warn "Host uid is #{Process.uid}, container user is 1000; file ownership may not match" unless Process.uid == 1000

    # `-e NAME` with no value copies it from this process, keeping keys out of the command line
    ENV['ANTHROPIC_BASE_URL'] ||= ANTHROPIC_BASE_URL
    cmd = %w[docker run --rm]
    cmd << '-it' if args[:prompt].nil?
    %w[ANTHROPIC_API_KEY ANTHROPIC_BASE_URL ANTHROPIC_USER_ID].each { |name| cmd.push('-e', name) if ENV[name] }
    cmd.push('-v', "#{target_path}:/workspace", CLAUDE_IMAGE, 'claude')
    if args[:prompt]
      cmd.push('-p', args[:prompt])
      # Edits land on the mounted host directory, so skipping prompts is opt-in
      cmd << '--dangerously-skip-permissions' if ENV['SKIP_PERMISSIONS'] == '1'
    end

    system(*cmd) || raise('claude (docker) execution failed')
  end

  desc 'Run Claude Code in a throwaway ubuntu:24.04 container, installed fresh each time (headless with a prompt)'
  task :popup, [:path, :prompt] do |_t, args|
    target_path = File.expand_path(args[:path] || '.')
    raise "No such directory: #{target_path}" unless Dir.exist?(target_path)
    raise "Missing ANTHROPIC_API_KEY" if ANTHROPIC_API_KEY.nil? || ANTHROPIC_API_KEY.empty?

    # Runs as root: files it creates in the mount are root-owned
    claude = ['exec ~/.local/bin/claude']
    claude.push('-p', Shellwords.escape(args[:prompt])) if args[:prompt]
    setup = 'apt-get update -qq && apt-get install -y -qq curl ca-certificates git >/dev/null' \
            ' && curl -fsSL https://claude.ai/install.sh | bash && ' + claude.join(' ')

    ENV['ANTHROPIC_BASE_URL'] ||= ANTHROPIC_BASE_URL
    cmd = %w[docker run --rm]
    cmd << '-it' if args[:prompt].nil?
    %w[ANTHROPIC_API_KEY ANTHROPIC_BASE_URL ANTHROPIC_USER_ID].each { |name| cmd.push('-e', name) if ENV[name] }
    cmd.push('-v', "#{target_path}:/work", '-w', '/work', 'ubuntu:24.04', 'bash', '-c', setup)

    system(*cmd) || raise('claude (popup) execution failed')
  end
end
# ==============================================================================
# CONFIGURATION & REPOSITORY BOOTSTRAP
# ==============================================================================
# Sets up global paths and declares Rake directory dependencies.
#
# TOOLKIT_REPO: Target Git repository containing the core Surge AI Python SDK.
# TOOLKIT_DIR:  Local vendor path where the repository is cloned/managed.
# DOCKER_POOL:  Local repository/knowledge store for cataloging both functional
#               and edge-case-failing Dockerfile configurations.
#
# The `directory` task declarations instruct Rake to automatically create these
# physical directory structures on the filesystem before executing any tasks
# that declare them as prerequisites (e.g., `:select_docker` or `:sync_toolkit`).
# ==============================================================================
TOOLKIT_REPO = 'https://github.com/surge-ai/surge-python.git'
TOOLKIT_DIR = 'vendor/surge-python'
DOCKER_POOL = 'knowledge_pool/dockers'

directory DOCKER_POOL
directory 'vendor'


desc 'Full worker lifecycle execution'
task default: %i[sync_toolkit select_docker verify_and_submit]

desc 'Check for latest Surge AI toolkit and optionally update/install'
task :sync_toolkit => 'vendor' do
  if Dir.exist?(TOOLKIT_DIR)
    puts 'Checking for toolkit updates...'
    cd TOOLKIT_DIR do
      sh 'git fetch origin --quiet'
      status = `git status -uno`
      if status.include?('behind')
        print 'New toolkit version available. Update now? [y/N]: '
        if $stdin.gets.strip.downcase == 'y'
          sh 'git pull origin main'
          sh 'pip install -e .'
        end
      else
        puts 'Toolkit is up to date.'
      end
    end
  else
  end
end



desc 'Search GitHub for Dockerfiles running Ruby GUI apps'
task :find_gui_dockers do
# Rakefile
  require 'net/http'
  require 'json'
  require 'uri'
  token = ENV['GITHUB_TOKEN']

  # Search query targeting Dockerfiles with Ruby base/deps + X11/GUI setup
#  query = 'filename:Dockerfile "FROM ruby" ("DISPLAY" OR "libx11" OR "gosu" OR "tk" OR "qt" OR "shoes")'

  query = 'filename:Dockerfile "FROM ruby"'
  url = URI("https://api.github.com/search/code?q=#{URI.encode_www_form_component(query)}&per_page=15")

  req = Net::HTTP::Get.new(url)
  req['Accept'] = 'application/vnd.github.v3+json'
  req['User-Agent'] = 'Ruby-Rake-Scanner'
  req['Authorization'] = "Bearer #{token}" if token

  res = Net::HTTP.start(url.host, url.port, use_ssl: true) { |http| http.request(req) }

  if res.is_a?(Net::HTTPSuccess)
    data = JSON.parse(res.body)
    puts "Found #{data['total_count']} candidate Dockerfiles (showing top #{data['items'].size}):\n\n"


data['items'].each do |item|
      repo_slug = item['repository']['full_name'].tr('/', '_')
      filename = "#{repo_slug}_Dockerfile.txt"

      # Request raw blob contents from GitHub Git API
      blob_url = URI(item['url'])
      blob_req = Net::HTTP::Get.new(blob_url)
      blob_req['Accept'] = 'application/vnd.github.v3.raw'
      blob_req['Authorization'] = "Bearer #{token}" if token

      blob_res = Net::HTTP.start(blob_url.host, blob_url.port, use_ssl: true) { |h| h.request(blob_req) }

      if blob_res.is_a?(Net::HTTPSuccess)
        File.write(filename, blob_res.body)
        puts "Saved      : #{filename}"
      else
        puts "Failed     : Could not fetch content for #{item['repository']['full_name']}"
      end

      puts "Repository : #{item['repository']['full_name']}"
      puts "Path       : #{item['path']}"
      puts "URL        : #{item['html_url']}"
      puts "-" * 60
    end

  else
    puts "GitHub API Error [#{res.code}]: #{res.body}"
    puts "Tip: Pass GITHUB_TOKEN=your_token rake find_gui_dockers to avoid rate limits." unless token
  end
end

desc 'Clone and install the Surge AI toolkit into the local vendor path'
task :get_all => 'vendor' do
  puts 'Cloning Surge AI toolkit...'
  q = TOOLKIT_DIR
  FileUtils.rm_rf(TOOLKIT_DIR) if File.exist?(TOOLKIT_DIR)
  sh "git clone #{TOOLKIT_REPO} #{TOOLKIT_DIR}"
  cd(TOOLKIT_DIR) do sh 'pip install -e . --break-system-packages' end
end

desc 'Select Dockerfile most similar to current task requirements'
task :select_docker => DOCKER_POOL do
  candidates = Dir.glob("#{DOCKER_POOL}/*.Dockerfile")

  if candidates.empty?
    puts 'No existing Dockerfiles found in pool. Initializing default baseline...'
    File.write('Dockerfile', <<~DOCKER)
      FROM ubuntu:22.04
      ENV DEBIAN_FRONTEND=noninteractive
      WORKDIR /workspace
      RUN apt-get update && apt-get install -y python3 python3-pip build-essential
      CMD ["/bin/bash"]
    DOCKER
  else
    puts 'Available pool candidates:'
    candidates.each_with_index { |f, i| puts "  [#{i}] #{f}" }

    # Quick similarity check based on word overlaps with task prompt/requirements
    target_keywords = File.exist?('requirements.txt') ? File.read('requirements.txt').split : []
    best_match = candidates.max_by do |file|
      content = File.read(file).split
      (content & target_keywords).size
    end

    puts "Selecting candidate: #{best_match}"
    FileUtils.cp(best_match, 'Dockerfile')
  end

  puts 'Dockerfile ready for editing. Adjust tiny machine realities as needed.'
end

desc 'Test build, trap unique failure mode, and submit to knowledge pool'
task :verify_and_submit => DOCKER_POOL do
  build_log = 'docker_build.log'
  success = system("docker build . --no-cache 2>&1 | tee #{build_log}")

  if success
    puts 'Build succeeded! Reality verified.'
  else
    puts 'Build failed. Extracting distinct machine reality error signature...'

    # Extract failure fingerprint
    raw_log = File.read(build_log)
    error_signature = raw_log.lines.last(15).join
    hash = Digest::SHA256.hexdigest(error_signature)[0..7]

    submission_path = File.join(DOCKER_POOL, "failure_mode_#{hash}.Dockerfile")

    # Append error signature as context to the failing Dockerfile before pool check-in
    dockerfile_content = File.read('Dockerfile')
    annotated_content = <<~DOCKER
      # FAIL_SIGNATURE: #{hash}
      # ERROR_DETAILS:
      # #{error_signature.gsub("\n", "\n# ")}
      #{dockerfile_content}
    DOCKER

    File.write(submission_path, annotated_content)
    puts "Submitted failing Dockerfile configuration to knowledge pool: #{submission_path}"
  end

  FileUtils.rm_f(build_log)
end

# ==============================================================================
# HARBOR TASK CHAIN
# ==============================================================================
# Wraps the authoring toolkit's scripts/ as a dependency graph, so the README's
# build -> run -> reference -> submit sequence is encoded rather than remembered.
#
# TASK_TOOLKIT: authoring toolkit checkout (override with TASK_TOOLKIT=...).
#
#   rake 'task:from_snapshot[explore/snapshots/<dir>]'
#   rake 'task:build[my-slug]'
#   rake 'task:run[my-slug,4]'      # builds first, then runs 4 trials
#   rake 'task:reference[my-slug]'  # copies trials from the newest harbor job
#   rake 'task:regrade[my-slug]'    # re-grades every reference run
#   rake 'task:submit[my-slug]'     # refuses with fewer than 4 reference runs
#   rake 'task:all[my-slug]'        # run -> reference -> submit
# ==============================================================================
TASK_TOOLKIT = File.expand_path(ENV['TASK_TOOLKIT'] || 'awbw/worker-toolkit-human-essentials', __dir__)
MIN_REFERENCE_RUNS = 4

def toolkit_sh(cmd)
  cd(TASK_TOOLKIT) { sh cmd }
end

def require_slug(args)
  slug = args[:slug]
  raise 'Usage: rake "task:<target>[slug]"' if slug.nil? || slug.empty?
  raise "No such task: #{TASK_TOOLKIT}/harbor-tasks/#{slug}" unless Dir.exist?(File.join(TASK_TOOLKIT, 'harbor-tasks', slug))
  slug
end

namespace :task do

  desc 'List snapshots and harbor tasks, with how far along each task is'
  task :list do
    snapshots = Dir.glob(File.join(TASK_TOOLKIT, 'explore', 'snapshots', '*')).select { |d| File.directory?(d) }
    tasks = Dir.glob(File.join(TASK_TOOLKIT, 'harbor-tasks', '*')).select { |d| File.directory?(d) }
                .reject { |d| File.basename(d).start_with?('_') }

    puts "Snapshots (explore/snapshots/) — build with task:from_snapshot[<path>]:"
    puts '  (none yet)' if snapshots.empty?
    snapshots.sort.each { |d| puts "  explore/snapshots/#{File.basename(d)}" }

    puts "\nHarbor tasks (harbor-tasks/):"
    puts '  (none yet)' if tasks.empty?
    tasks.sort.each do |dir|
      runs = Dir.glob(File.join(dir, 'reference-runs', '*')).count { |d| File.directory?(d) }
      marks = {
        'workspace' => Dir.exist?(File.join(dir, 'environment', 'workspace')),
        'rubric'    => File.exist?(File.join(dir, 'tests', 'holistic-rubric.md')),
        'atomic'    => File.exist?(File.join(dir, 'tests', 'atomic-rubric.yaml'))
      }.map { |name, ok| "#{ok ? '✔' : '·'} #{name}" }
      ready = runs >= MIN_REFERENCE_RUNS ? 'ready to submit' : "#{runs}/#{MIN_REFERENCE_RUNS} runs"
      puts format('  %-40s %s  %s', File.basename(dir), marks.join('  '), ready)
    end
  end

  desc 'List open upstream human-essentials issues as candidate task seeds'
  task :seeds, [:label, :limit] do |_t, args|
    require 'net/http'
    require 'json'
    require 'uri'

    limit = (args[:limit] || 30).to_i
    params = { state: 'open', sort: 'created', direction: 'desc', per_page: [limit, 100].min }
    params[:labels] = args[:label] if args[:label]
    url = URI("https://api.github.com/repos/rubyforgood/human-essentials/issues?#{URI.encode_www_form(params)}")

    req = Net::HTTP::Get.new(url)
    req['Accept'] = 'application/vnd.github.v3+json'
    req['User-Agent'] = 'Ruby-Rake-Scanner'
    req['Authorization'] = "Bearer #{ENV['GITHUB_TOKEN']}" if ENV['GITHUB_TOKEN']
    res = Net::HTTP.start(url.host, url.port, use_ssl: true) { |http| http.request(req) }
    raise "GitHub API Error [#{res.code}]: #{res.body}" unless res.is_a?(Net::HTTPSuccess)

    # Issues filed after the pinned commit may describe code the workspace doesn't have yet
    pinned = `git -C #{File.join(TASK_TOOLKIT, 'repo')} log -1 --format=%cI`.strip
    issues = JSON.parse(res.body).reject { |i| i['pull_request'] }

    puts "Open issues (workspace pinned at #{pinned[0, 10]}; * = filed after it):"
    issues.each do |i|
      after = !pinned.empty? && i['created_at'] > pinned ? '*' : ' '
      labels = i['labels'].map { |l| l['name'] }.join(', ')
      puts format('%s #%-5d %s  %s', after, i['number'], i['created_at'][0, 10], i['title'])
      puts "         [#{labels}]" unless labels.empty?
      puts "         #{i['html_url']}"
    end
  end

  desc 'Build a harbor task from an explore snapshot'
  task :from_snapshot, [:snapshot] do |_t, args|
    raise 'Usage: rake "task:from_snapshot[explore/snapshots/<dir>]"' unless args[:snapshot]
    toolkit_sh "npx tsx scripts/snapshot-to-task.ts --snapshot #{args[:snapshot]}"
  end

  desc 'Build the workspace and stage test-commands.sh for a task'
  task :build, [:slug] do |_t, args|
    toolkit_sh "bash scripts/build-workspace.sh #{require_slug(args)}"
  end

  desc 'Run N parallel harbor trials of a task (default 4)'
  task :run, [:slug, :trials] => :build do |_t, args|
    trials = args[:trials] || MIN_REFERENCE_RUNS
    toolkit_sh "scripts/harbor-run harbor-tasks/#{require_slug(args)} --force-build -k #{trials}"
  end

  desc 'Copy every trial from the newest harbor job into reference-runs'
  task :reference, [:slug] do |_t, args|
    slug = require_slug(args)
    jobs = Dir.glob(File.join(TASK_TOOLKIT, 'harbor-jobs', '*')).select do |job|
      Dir.glob(File.join(job, "#{slug}__*")).any?
    end
    raise "No harbor job found for #{slug}; run task:run first" if jobs.empty?

    job = File.basename(jobs.max_by { |j| File.mtime(j) })
    toolkit_sh "npx tsx scripts/copy-reference-run.ts harbor-jobs/#{job}/#{slug}__*"
  end

  desc 'Re-grade every captured reference run (after editing the rubric)'
  task :regrade, [:slug] do |_t, args|
    toolkit_sh "scripts/harbor-regrade harbor-tasks/#{require_slug(args)} --all"
  end

  desc 'Fail unless the task has a holistic rubric'
  task :rubric, [:slug] do |_t, args|
    slug = require_slug(args)
    unless File.exist?(File.join(TASK_TOOLKIT, 'harbor-tasks', slug, 'tests', 'holistic-rubric.md'))
      raise "#{slug} has no tests/holistic-rubric.md; write it (/write-holistic-rubric) before grading or submitting. " \
            'task:all_runs runs trials without it.'
    end
  end

  desc 'Validate and package a task for submission'
  task :submit, [:slug] => :rubric do |_t, args|
    slug = require_slug(args)
    runs = Dir.glob(File.join(TASK_TOOLKIT, 'harbor-tasks', slug, 'reference-runs', '*')).select { |d| File.directory?(d) }
    if runs.size < MIN_REFERENCE_RUNS
      raise "#{slug} has #{runs.size} reference runs; need #{MIN_REFERENCE_RUNS}. Run task:run and task:reference first."
    end
    toolkit_sh "npx tsx scripts/submit-task.ts #{slug}"
  end

  desc 'Trials only: build -> run -> reference (no rubric needed)'
  task :all_runs, [:slug, :trials] => %i[run reference]

  desc 'Full chain, after the rubric is written: rubric check -> build -> run -> reference -> submit'
  task :all, [:slug, :trials] => %i[rubric run reference submit]
end


require "io/console"

namespace :env do
  desc "Configure Anthropic environment variables and open console"
  task :setup_anthropic do
    url = "https://console.anthropic.com/settings/keys"

    puts <<~TEXT

      === Anthropic Environment Setup ===

      1. ANTHROPIC_API_KEY:
         Generated at: #{url}

      2. ANTHROPIC_BASE_URL (Optional):
         Default: https://api.anthropic.com (or your proxy endpoint)

      Add to ~/.bash_aliases:
        export ANTHROPIC_API_KEY="your_actual_api_key_here"
        export ANTHROPIC_BASE_URL="https://api.anthropic.com"

      Then run:
        source ~/.bash_aliases

    TEXT

    print "Open Anthropic Console in Chromium now? (y/N): "
    input = $stdin.gets&.strip&.downcase

    if input == "y" || input == "yes"
      puts "Opening Chromium..."
      system("chromium", url) || system("chromium-browser", url) || raise("Failed to launch Chromium.")
    else
      raise "User declined setup."
    end
  end
end


desc "Run Shoes application headlessly under Xvfb"
task :default do
  sh "xvfb-run --auto-servernum ruby app.rb"
end

desc "Run Shoes application and capture render screenshot"
task :screenshot do
  sh "xvfb-run --auto-servernum ruby app.rb &"
  sleep 2
  sh "import -window root /workspace/render.png"
end
