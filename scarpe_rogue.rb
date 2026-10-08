# Run with: ruby scarpe_rogue.rb
# Or in a browser: ruby scarpe_rogue.rb --web [port], then open http://localhost:4567/

require 'socket'
require 'uri'

# The game knows nothing about Scarpe; the app below only draws it and pushes buttons
class Dungeon
  WIDTH  = 48
  HEIGHT = 18
  SIGHT  = 6

  # Spawning draws from the first depth + 1 rows, so order sets the depth each kind first appears
  MONSTERS = [
    { glyph: "@", name: "Ego",      hp: 13, str: 15, dex: 15, con: 11, int: 15, wis: 15, cha: 14,  hit: 1..6 },
    { glyph: "🗡️", # "༺𓆩༒︎𓆪༻",
      name: "weapon", hp: 18, str: 18, dex: 10, con: 18, int: 18, wis: 10, cha: 10,  hit: 2..12, pacifist: true },
    { glyph: "r", name: "rat",      hp:  3, str:  7, dex: 15, con: 11, int:  2, wis: 10, cha:  4,  hit: 1..2 },
    { glyph: "g", name: "goblin",   hp:  6, str:  8, dex: 17, con: 10, int: 13, wis: 15, cha: 10,  hit: 1..4 },
    { glyph: "o", name: "orc",      hp: 10, str: 14, dex: 12, con: 17, int: 15, wis: 10, cha: 10,  hit: 2..6 },
    { glyph: "T", name: "troll",    hp: 18, str: 16, dex: 10, con: 18, int: 10, wis: 10, cha: 10,  hit: 3..8 },
    { glyph: "#", name: "wall",     hp: 30, str: 18, dex:  0, con: 18, int:  0, wis:  0, cha:  0,  hit: 0..0, pacifist: true },
    { glyph: "$", name: "gold",     hp: 30, str: 18, dex:  0, con: 18, int:  0, wis:  0, cha:  0,  hit: 0...0, pacifist: true },
    { glyph: "=", name: "sandwich", hp:  3, str:  2, dex:  0, con:  2, int:  0, wis:  0, cha:  0,  hit: 0..0, pacifist: true },
    { glyph: "¡", name: "potion", hp:  3, str:  2, dex:  0, con:  2, int:  0, wis:  0, cha:  0,  hit: 0..0, pacifist: true },
    { glyph: "Q", name: "Quail",    hp: 28, str: 18, dex: 17, con: 16, int: 15, wis: 14, cha: 13,  hit: 4..9, pacifist: true },
  ]

  #⚔️🛡️ 🏹  hey our real development went to Ruby Rogue

  Monster = Struct.new(:x, :y, :glyph, :name, :hp, :hit, :pacifist, :spurned)

  attr_reader :hp, :max_hp, :knapsack, :depth, :log

  def initialize
    @max_hp = 20
    @hp = @max_hp
    @knapsack = { gold: 0, sandwiches: 0 }
    @depth = 1
    @log = ["You descend into the dark. Find the stairs (>)."]
    return build_level()
  end

  def over?
    @hp <= 0
  end

  def gold
    @knapsack[:gold]
  end

  def sandwiches
    @knapsack[:sandwiches]
  end

  # Walking into a monster attacks it; walking onto > goes deeper
  def move(dx, dy)
    return if over?

    nx = @px + dx
    ny = @py + dy
    return say("You bump the wall.") if wall?(nx, ny)

    if (foe = monster_at(nx, ny))
      attack(foe)
    else
      @px, @py = nx, ny
      pick_up
      return descend if @map[@py][@px] == ">"
    end

    monsters_act
    reveal
  end

  def rest
    return if over?

    @hp = [@hp + 1, @max_hp].min
    say "You catch your breath."
    monsters_act
  end

  def rows
    Array.new(HEIGHT) do |y|
      Array.new(WIDTH) { |x| glyph_at(x, y) }.join
    end
  end

  private

  def build_level
    @map = Array.new(HEIGHT) { Array.new(WIDTH, "#") }
    @seen = Array.new(HEIGHT) { Array.new(WIDTH, false) }
    @rooms = []

    40.times do
      w = rand(5..11)
      h = rand(3..5)
      room = { x: rand(1..WIDTH - w - 2), y: rand(1..HEIGHT - h - 2), w: w, h: h }
      next if @rooms.any? { |r| overlap?(r, room) }
      carve_room(room)
      tunnel(center(@rooms.last), center(room)) if @rooms.any?
      @rooms << room
      break if @rooms.size >= 8
    end

    @px, @py = center(@rooms.first)
    sx, sy = center(@rooms.last)
    @map[sy][sx] = ">"

    @treasure = {}
    @sandwiches = {}
    @monsters = []
    @rooms.drop(1).each do |room|
      rand(0..2).times { @treasure[free_spot(room)] = rand(5..20) * @depth }
      @sandwiches[free_spot(room)] = 1 if rand(3).zero?
      rand(0..2).times { spawn_monster(room) }
    end
    reveal
  end

  def overlap?(a, b)
    a[:x] - 1 <= b[:x] + b[:w] && b[:x] - 1 <= a[:x] + a[:w] &&
      a[:y] - 1 <= b[:y] + b[:h] && b[:y] - 1 <= a[:y] + a[:h]
  end

  def carve_room(r)
    (r[:y]...r[:y] + r[:h]).each { |y| (r[:x]...r[:x] + r[:w]).each { |x| @map[y][x] = "." } }
  end

  def center(r)
    [r[:x] + r[:w] / 2, r[:y] + r[:h] / 2]
  end

  # L-shaped tunnel, randomly horizontal-first or vertical-first
  def tunnel((x1, y1), (x2, y2))
    if rand(2).zero?
      dig_h(x1, x2, y1)
      dig_v(y1, y2, x2)
    else
      dig_v(y1, y2, x1)
      dig_h(x1, x2, y2)
    end
  end

  def dig_h(x1, x2, y)
    return ([x1, x2].min..[x1, x2].max).each { |x| @map[y][x] = "." if @map[y][x] == "#" }
  end

  def dig_v(y1, y2, x)
    return ([y1, y2].min..[y1, y2].max).each { |y| @map[y][x] = "." if @map[y][x] == "#" }
  end

  def free_spot(room)
    loop do
      spot = [rand(room[:x]...room[:x] + room[:w]), rand(room[:y]...room[:y] + room[:h])]
      next if spot == [@px, @py] || @map[spot[1]][spot[0]] == ">"
      next if @treasure.key?(spot) || @sandwiches.key?(spot) || monster_at(*spot)

      return spot
    end
  end

  # Deeper levels unlock the nastier monsters
  def spawn_monster(room)
    kind = MONSTERS.first([@depth + 1, MONSTERS.size].min).sample
    x, y = free_spot(room)
    @monsters << Monster.new(x, y, kind[:glyph], kind[:name], kind[:hp] + @depth, kind[:hit], kind[:pacifist])
  end

  def wall?(x, y)
    return x.negative? || y.negative? || x >= WIDTH || y >= HEIGHT || @map[y][x] == "#"
  end

  def monster_at(x, y) return @monsters.find { |m| m.x == x && m.y == y } end

  # The first hit on a pacifist also spurns it
  def attack(foe)
    dmg = rand(2..6)
    foe.hp -= dmg
    if foe.hp <= 0
      @monsters.delete(foe)
      say "You slay the #{foe.name}!"
      explode(foe) if foe.name == "Quail"
    elsif foe.pacifist && !foe.spurned
      foe.spurned = true
      say "You hit the #{foe.name} for #{dmg}. It stops following you."
    else
      say "You hit the #{foe.name} for #{dmg}."
    end
  end

  # Strews the sandwiches over open floor around where the Quail fell, piling any extras on its own spot
  def explode(foe)
    around = [-1, 0, 1].product([-1, 0, 1]).map { |dx, dy| [foe.x + dx, foe.y + dy] }
    spots = around.reject { |x, y| wall?(x, y) || [x, y] == [@px, @py] || @treasure.key?([x, y]) || monster_at(x, y) }.shuffle
    count = rand(1..5)
    count.times do |i|
      spot = spots[i] || [foe.x, foe.y]
      @sandwiches[spot] = @sandwiches.fetch(spot, 0) + 1
    end
    say "The #{foe.name} explodes into #{count} #{count == 1 ? "sandwich" : "sandwiches"}!"
  end

  def pick_up
    if (coins = @treasure.delete([@px, @py]))
      @knapsack[:gold] += coins
      say "You find #{coins} gold!"
    end
    return unless (count = @sandwiches.delete([@px, @py]))

    @knapsack[:sandwiches] += count
    say "You pack #{count == 1 ? "a sandwich" : "#{count} sandwiches"} into your knapsack."
  end

  def descend
    @depth += 1
    @max_hp += 2
    @hp = [@hp + 5, @max_hp].min
    say "You take the stairs down to depth #{@depth}."
    return build_level
  end

  # Monsters within sight chase the player and strike when adjacent
  def monsters_act
    @monsters.each do |m|
      next if m.spurned

      dx = @px - m.x
      dy = @py - m.y
      next if dx.abs > SIGHT || dy.abs > SIGHT

      if dx.abs + dy.abs == 1
        next if m.pacifist

        dmg = rand(m.hit)
        @hp -= dmg
        say "The #{m.name} hits you for #{dmg}."
        return say("You die on depth #{@depth} with #{gold} gold.") if over?
      else
        step = dx.abs >= dy.abs ? [dx <=> 0, 0] : [0, dy <=> 0]
        nx, ny = m.x + step[0], m.y + step[1]
        m.x, m.y = nx, ny unless wall?(nx, ny) || monster_at(nx, ny) || [nx, ny] == [@px, @py]
      end
    end
  end

  def reveal
    (@py - SIGHT..@py + SIGHT).each do |y|
      (@px - SIGHT..@px + SIGHT).each do |x|
        @seen[y][x] = true if x.between?(0, WIDTH - 1) && y.between?(0, HEIGHT - 1)
      end
    end
  end

  def glyph_at(x, y)
    return "@" if [x, y] == [@px, @py]
    return " " unless @seen[y][x]

    near = (x - @px).abs <= SIGHT && (y - @py).abs <= SIGHT
    if near && (m = monster_at(x, y)) then m.glyph
    elsif @treasure.key?([x, y]) then "$"
    elsif @sandwiches.key?([x, y]) then "%"
    else @map[y][x]
    end
  end

  def say(msg)
    @log = (@log + [msg]).last(4)
    nil
  end
end

# The movement pad both front ends draw: label, dx, dy, and the browser keys that press it
PAD = [
  [["↖", -1, -1, "y 7 Home"], ["↑", 0, -1, "k 8 ArrowUp"],  ["↗", 1, -1, "u 9 PageUp"]],
  [["←", -1,  0, "h 4 ArrowLeft"], ["rest", 0,  0, ". 5 Clear"], ["→", 1,  0, "l 6 ArrowRight"]],
  [["↙", -1,  1, "b 1 End"], ["↓", 0,  1, "j 2 ArrowDown"], ["↘", 1,  1, "n 3 PageDown"]],
]

# Serves one shared Dungeon over plain HTTP; each button is a form that POSTs, then redirects back
class WebGame
  attr_reader :game

  def initialize
    @game = Dungeon.new
  end

  def serve(port)
    server = TCPServer.new(port)
    puts "Quail on the Run at http://localhost:#{port}/"
    loop do
      client = server.accept
      begin
        handle(client)
      rescue StandardError => e
        warn "#{e.class}: #{e.message}"
      ensure
        client.close
      end
    end
  end

  # Returns [status, headers, body]; redirecting after each POST keeps a reload from repeating the move
  def respond(method, target)
    path, query = target.to_s.split("?", 2)
    params = URI.decode_www_form(query.to_s).to_h

    if method == "POST"
      case path
      when "/move" then @game.move(params["dx"].to_i.clamp(-1, 1), params["dy"].to_i.clamp(-1, 1))
      when "/rest" then @game.rest
      when "/new"  then @game = Dungeon.new
      else return [404, {}, "Not found"]
      end
      return [303, { "Location" => "/" }, ""]
    end

    return [404, {}, "Not found"] unless method == "GET" && path == "/"

    [200, { "Content-Type" => "text/html; charset=utf-8" }, page]
  end

  private

  def handle(client)
    method, target = client.gets.to_s.split
    length = 0
    while (line = client.gets) && line != "\r\n"
      length = line.split(":", 2).last.to_i if line.match?(/\Acontent-length:/i)
    end
    client.read(length) if length.positive?

    status, headers, body = respond(method, target)
    reason = { 200 => "OK", 303 => "See Other", 404 => "Not Found" }[status]
    head = headers.merge("Content-Length" => body.bytesize, "Connection" => "close")
    client.write "HTTP/1.1 #{status} #{reason}\r\n#{head.map { |k, v| "#{k}: #{v}\r\n" }.join}\r\n#{body}"
  end

  def h(text)
    text.to_s.gsub("&", "&amp;").gsub("<", "&lt;").gsub(">", "&gt;").gsub('"', "&quot;")
  end

  def page
    buttons = PAD.flatten(1).map do |label, dx, dy, keys|
      action = dx.zero? && dy.zero? ? "/rest" : "/move?dx=#{dx}&amp;dy=#{dy}"
      %(<form method="post" action="#{action}"><button data-keys="#{h keys}">#{label}</button></form>)
    end

    <<~HTML
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Quail on the Run</title>
        <style>
          body { background: #111; color: #ddd; font-family: sans-serif; }
          pre { font-size: 15px; line-height: 1.1; }
          .pad { display: grid; grid-template-columns: repeat(3, 60px); gap: 4px; }
          form { margin: 0; }
          button { width: 100%; }
        </style>
      </head>
      <body>
        <p>HP #{@game.hp}/#{@game.max_hp} &nbsp; Gold #{@game.gold} &nbsp; Sandwiches #{@game.sandwiches} &nbsp; Depth #{@game.depth}</p>
        <pre>#{h @game.rows.join("\n")}</pre>
        <p>#{@game.log.map { |line| h line }.join("<br>")}</p>
        <div class="pad">#{buttons.join}</div>
        <form method="post" action="/new"><button style="width: auto">New game</button></form>
        <script>
          document.addEventListener("keydown", e => {
            const b = [...document.querySelectorAll("[data-keys]")].find(b => b.dataset.keys.split(" ").includes(e.key))
            if (b) { e.preventDefault(); b.click() }
          })
        </script>
      </body>
      </html>
    HTML
  end
end

# Guarded so the tests can require this file for Dungeon without opening a window or a port.
# Scarpe 0.5.0 has no Scarpe.app; requiring scarpe provides Shoes.app instead.
if $PROGRAM_NAME == __FILE__ && ARGV.first == "--web"
  WebGame.new.serve(Integer(ARGV[1] || 4567))
elsif $PROGRAM_NAME == __FILE__
gem 'scarpe' # '0.1.0'
require 'scarpe'
Scarpe.app(title: "Scarpe Rogue") do # , width: 560, height: 640) do
  @game = Dungeon.new

  @status = stack(size: 1){}
  # Newlines become <br>, but runs of spaces still collapse, so blanks go in as non-breaking spaces
  @map = stack(family: "monospace", size: 11){}
  @log = stack(size: 10){}

  #  make aggressive things attack the TODO weapon and the mobile wall

  redraw = lambda do
    @status.replace "HP #{@game.hp}/#{@game.max_hp}   Gold #{@game.gold}   Sandwiches #{@game.sandwiches}   Depth #{@game.depth}"
    @map.replace @game.rows.join("\n").tr(" ", "\u00A0")
    @log.replace @game.log.join("\n")
  end

  # Keypress isn't wired up in Scarpe 0.5.0's webview display yet, so moving is by button
  PAD.each do |line|
    flow do
      line.each do |label, dx, dy|
        button(label, width: 60) do
          dx.zero? && dy.zero? ? @game.rest : @game.move(dx, dy)
          redraw.call
        end
      end
    end
  end

  flow do
    button("New game") do
      @game = Dungeon.new
      redraw.call
    end
  end

  redraw.call
end
end
