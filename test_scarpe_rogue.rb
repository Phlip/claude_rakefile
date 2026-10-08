# Run with: ruby test_scarpe_rogue.rb

require 'minitest/autorun'
require_relative 'scarpe_rogue'

class DungeonTest < Minitest::Test
  W = Dungeon::WIDTH
  H = Dungeon::HEIGHT

  def setup
    srand(1234)
    @game = Dungeon.new
  end

  def ivar(name) = @game.instance_variable_get("@#{name}")
  def set(name, value) = @game.instance_variable_set("@#{name}", value)

  # Replaces the random level with one open room walled at the border, fully seen,
  # so each test places exactly the pieces it cares about
  def arena(px: 5, py: 5)
    set :map, Array.new(H) { |y| Array.new(W) { |x| [0, W - 1].include?(x) || [0, H - 1].include?(y) ? "#" : "." } }
    set :seen, Array.new(H) { Array.new(W, true) }
    set :monsters, []
    set :treasure, {}
    set :sandwiches, {}
    set :px, px
    set :py, py
  end

  def add_monster(x, y, hp: 10, hit: 3..3)
    ivar(:monsters) << Dungeon::Monster.new(x, y, "g", "goblin", hp, hit)
  end

  def add_quail(x, y, hp: 100)
    ivar(:monsters) << Dungeon::Monster.new(x, y, "Q", "Quail", hp, 0..0, true)
  end

  def player = [ivar(:px), ivar(:py)]
  def last_log = @game.log.last

  # --- a new game ---

  def test_new_game_starts_with_full_health_and_no_gold
    assert_equal 20, @game.hp
    assert_equal 20, @game.max_hp
    assert_equal({ gold: 0, sandwiches: 0 }, @game.knapsack)
    assert_equal 1, @game.depth
    assert_equal 1, @game.log.size
    refute @game.over?
  end

  # --- level generation, checked across many seeds ---

  def each_level
    50.times do |seed|
      srand(seed)
      @game = Dungeon.new
      yield seed
    end
  end

  def test_rows_match_the_map_size
    each_level do |seed|
      rows = @game.rows
      assert_equal H, rows.size, "seed #{seed}"
      assert(rows.all? { |r| r.size == W }, "seed #{seed}")
    end
  end

  def test_level_is_walled_at_the_border
    each_level do |seed|
      map = ivar(:map)
      assert(map.first.all?("#") && map.last.all?("#"), "seed #{seed}")
      assert(map.all? { |row| row.first == "#" && row.last == "#" }, "seed #{seed}")
    end
  end

  def test_level_has_exactly_one_staircase
    each_level do |seed|
      assert_equal 1, ivar(:map).flatten.count(">"), "seed #{seed}"
    end
  end

  def test_player_starts_on_the_floor_away_from_the_stairs
    each_level do |seed|
      x, y = player
      assert_equal ".", ivar(:map)[y][x], "seed #{seed}"
    end
  end

  def test_tunnels_connect_every_floor_tile_to_the_player
    each_level do |seed|
      map = ivar(:map)
      reached = {}
      queue = [player]

      until queue.empty?
        x, y = queue.shift
        next if reached[[x, y]] || map[y][x] == "#"

        reached[[x, y]] = true
        queue.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1])
      end

      open = (0...H).flat_map { |y| (0...W).map { |x| [x, y] } }.reject { |x, y| map[y][x] == "#" }
      assert_equal open.sort, reached.keys.sort, "seed #{seed}: unreachable tiles"
    end
  end

  def test_treasure_sandwiches_and_monsters_sit_on_free_floor
    each_level do |seed|
      map = ivar(:map)
      spots = ivar(:treasure).keys + ivar(:sandwiches).keys + ivar(:monsters).map { |m| [m.x, m.y] }
      spots.each { |x, y| assert_equal ".", map[y][x], "seed #{seed} at #{[x, y]}" }
      refute_includes spots, player, "seed #{seed}"
      assert_equal spots.uniq.size, spots.size, "seed #{seed}: overlap"
    end
  end

  def test_levels_scatter_a_few_single_sandwiches
    counts = []

    each_level do |seed|
      assert(ivar(:sandwiches).values.all?(1), "seed #{seed}")
      counts << ivar(:sandwiches).size
    end
    
    assert(counts.any?(&:positive?), "some level should have sandwiches")
    assert(counts.all? { |n| n <= 7 }, "at most one per room past the first")
  end

  # --- monster spawning by depth ---

  def spawn_many(depth)
    arena(px: 1, py: 1)
    set :depth, depth
    room = { x: 2, y: 2, w: W - 4, h: H - 4 }
    150.times { @game.send(:spawn_monster, room) }
    ivar(:monsters)
  end

  def test_depth_one_only_spawns_rats_and_goblins
    assert_equal %w[g r], spawn_many(1).map(&:glyph).uniq.sort
  end

  def test_deeper_levels_spawn_every_kind
    assert_equal %w[T g o r], spawn_many(3).map(&:glyph).uniq.sort
  end

  def test_monsters_get_tougher_with_depth
    rat = Dungeon::MONSTERS.find { |k| k[:glyph] == "r" }
    spawn_many(4).select { |m| m.glyph == "r" }.each { |m| assert_equal rat[:hp] + 4, m.hp }
  end

  # --- moving ---

  def test_moving_onto_floor_moves_the_player
    arena
    @game.move(1, 0)
    assert_equal [6, 5], player
    @game.move(-1, 1)
    assert_equal [5, 6], player
  end

  def test_walking_into_a_wall_stays_put
    arena(px: 1, py: 1)
    @game.move(-1, 0)
    assert_equal [1, 1], player
    assert_equal "You bump the wall.", last_log
  end

  def test_moving_off_the_map_edge_is_a_wall
    arena(px: 0, py: 0)
    @game.move(-1, -1)
    assert_equal [0, 0], player
  end

  def test_player_is_drawn_as_at_sign
    arena
    assert_equal "@", @game.rows[5][5]
  end

  # --- treasure ---

  def test_stepping_on_treasure_collects_it
    arena
    ivar(:treasure)[[6, 5]] = 15
    assert_equal "$", @game.rows[5][6]

    @game.move(1, 0)
    assert_equal 15, @game.gold
    assert_empty ivar(:treasure)
    assert_equal "You find 15 gold!", last_log
  end

  # --- combat ---

  def test_walking_into_a_monster_attacks_without_moving
    arena
    add_monster(6, 5, hp: 100, hit: 0..0)
    @game.move(1, 0)
    assert_equal [5, 5], player
    assert_includes 94..98, ivar(:monsters).first.hp
  end

  def test_killing_a_monster_removes_it
    arena
    add_monster(6, 5, hp: 1)
    @game.move(1, 0)
    assert_empty ivar(:monsters)
    assert_equal "You slay the goblin!", last_log
  end

  def test_adjacent_monster_hits_the_player
    arena
    add_monster(5, 6, hp: 100, hit: 3..3)
    @game.rest
    assert_equal 17, @game.hp # resting heals nothing at full health, then the hit lands
    assert_equal "The goblin hits you for 3.", last_log
  end

  def test_diagonal_monster_does_not_attack
    arena
    add_monster(6, 6, hit: 3..3)
    @game.rest
    assert_equal 20, @game.hp
  end

  def test_death_ends_the_game
    arena
    set :hp, 2
    add_monster(6, 5, hp: 100, hit: 5..5)
    @game.rest
    assert @game.over?
    assert_match(/You die on depth 1/, last_log)

    @game.move(0, 1)
    assert_equal [5, 5], player, "no moves after death"
  end

  # --- monster movement ---

  def test_monster_in_sight_steps_toward_the_player
    arena
    add_monster(9, 5)
    @game.rest
    m = ivar(:monsters).first
    assert_equal [8, 5], [m.x, m.y]
  end

  def test_monster_closes_the_longer_axis_first
    arena
    add_monster(7, 9)
    @game.rest
    m = ivar(:monsters).first
    assert_equal [7, 8], [m.x, m.y]
  end

  def test_monster_out_of_sight_stays_put
    arena
    add_monster(5 + Dungeon::SIGHT + 1, 5)
    @game.rest
    m = ivar(:monsters).first
    assert_equal [5 + Dungeon::SIGHT + 1, 5], [m.x, m.y]
  end

  def test_monster_does_not_walk_through_walls
    arena
    ivar(:map)[5][7] = "#"
    add_monster(8, 5)
    @game.rest
    m = ivar(:monsters).first
    assert_equal [8, 5], [m.x, m.y]
  end

  def test_monsters_do_not_stack
    arena
    add_monster(8, 5)
    add_monster(9, 5)
    ivar(:map)[5][7] = "#"
    @game.rest
    assert_equal [[8, 5], [9, 5]], ivar(:monsters).map { |m| [m.x, m.y] }
  end

  # --- the pacifist Quails are nummy ---

  def test_quail_first_spawns_at_depth_four
    refute_includes spawn_many(3).map(&:glyph), "Q"
    quails = spawn_many(4).select { |m| m.glyph == "Q" }
    refute_empty quails
    assert(quails.all?(&:pacifist))
  end

  def test_quail_follows_the_player
    arena
    add_quail(9, 5)
    @game.rest
    q = ivar(:monsters).first
    assert_equal [8, 5], [q.x, q.y]
  end

  def test_adjacent_quail_never_hits
    arena
    add_quail(6, 5)
    3.times { @game.rest }
    assert_equal 20, @game.hp
    q = ivar(:monsters).first
    assert_equal [6, 5], [q.x, q.y]
  end

  def test_hitting_the_quail_makes_it_stop_following
    arena
    add_quail(6, 5)
    @game.move(1, 0)
    q = ivar(:monsters).first
    assert q.spurned
    assert_match(/It stops following you\./, last_log)

    @game.move(-1, 0)
    @game.move(-1, 0)
    assert_equal [6, 5], [q.x, q.y]
  end

  def test_hitting_the_quail_hurts_it
    arena
    add_quail(6, 5)
    @game.move(1, 0)
    assert_includes 94..98, ivar(:monsters).first.hp
  end

  def test_slain_quail_explodes_into_one_to_five_sandwiches_around_it
    50.times do |seed|
      srand(seed)
      arena
      add_quail(6, 5, hp: 1)
      @game.move(1, 0)
      assert_empty ivar(:monsters)
      sandwiches = ivar(:sandwiches)
      assert_includes 1..5, sandwiches.values.sum, "seed #{seed}"
      assert(sandwiches.keys.all? { |x, y| (x - 6).abs <= 1 && (y - 5).abs <= 1 }, "seed #{seed}")
      refute_includes sandwiches.keys, player, "seed #{seed}"
      assert_match(/The Quail explodes into [1-5] sandwich/, last_log)
    end
  end

  def test_extra_sandwiches_pile_up_when_the_quail_is_boxed_in
    piled = 20.times.map do |seed|
      srand(seed)
      arena
      ivar(:map).each_with_index { |row, y| row.each_index { |x| row[x] = "#" unless [[5, 5], [6, 5]].include?([x, y]) } }
      add_quail(6, 5, hp: 1)
      @game.move(1, 0)
      assert_equal [[6, 5]], ivar(:sandwiches).keys, "seed #{seed}"
      ivar(:sandwiches)[[6, 5]]
    end
    assert(piled.any? { |n| n > 1 }, "some explosion should pile several sandwiches on one spot")
  end

  def test_sandwiches_are_drawn_as_percent
    arena
    ivar(:sandwiches)[[6, 5]] = 1
    assert_equal "%", @game.rows[5][6]
  end

  def test_stepping_on_sandwiches_packs_them_without_healing
    arena
    set :hp, 5
    ivar(:sandwiches)[[6, 5]] = 3
    @game.move(1, 0)
    assert_equal 5, @game.hp
    assert_equal 3, @game.sandwiches
    assert_empty ivar(:sandwiches)
    assert_equal "You pack 3 sandwiches into your knapsack.", last_log
  end

  def test_knapsack_collects_gold_and_sandwiches_together
    arena
    ivar(:treasure)[[6, 5]] = 15
    ivar(:sandwiches)[[6, 5]] = 1
    @game.move(1, 0)
    assert_equal({ gold: 15, sandwiches: 1 }, @game.knapsack)
    assert_equal "You pack a sandwich into your knapsack.", last_log
  end

  def test_spurned_quail_still_blocks_monsters_behind_it
    arena
    ivar(:map)[4][7] = "#"
    ivar(:map)[6][7] = "#"
    add_quail(7, 5).last.spurned = true
    add_monster(8, 5)
    @game.rest
    assert_equal [[7, 5], [8, 5]], ivar(:monsters).map { |m| [m.x, m.y] }
  end

  # --- stairs ---

  def test_stairs_lead_to_a_new_deeper_level
    arena
    ivar(:map)[5][6] = ">"
    set :hp, 10
    old_map = ivar(:map)

    @game.move(1, 0)
    assert_equal 2, @game.depth
    assert_equal 22, @game.max_hp
    assert_equal 15, @game.hp
    refute_same old_map, ivar(:map)
    assert_equal "You take the stairs down to depth 2.", last_log
  end

  def test_stair_healing_is_capped_at_max
    arena
    ivar(:map)[5][6] = ">"
    @game.move(1, 0)
    assert_equal @game.max_hp, @game.hp
  end

  # --- resting ---

  def test_rest_heals_one_point
    arena
    set :hp, 10
    @game.rest
    assert_equal 11, @game.hp
  end

  def test_rest_does_not_overheal
    arena
    @game.rest
    assert_equal 20, @game.hp
  end

  # --- what the player can see ---

  def test_unseen_tiles_are_blank
    arena
    set :seen, Array.new(H) { Array.new(W, false) }
    @game.send(:reveal)
    row = @game.rows[5]
    assert_equal ".", row[5 + Dungeon::SIGHT]
    assert_equal " ", row[5 + Dungeon::SIGHT + 1]
  end

  def test_seen_tiles_stay_on_the_map_after_walking_away
    arena
    set :seen, Array.new(H) { Array.new(W, false) }
    @game.send(:reveal)
    (Dungeon::SIGHT + 3).times { @game.move(1, 0) }
    assert_equal ".", @game.rows[5][1]
  end

  def test_distant_monsters_are_hidden_even_on_seen_tiles
    arena
    far = 5 + Dungeon::SIGHT + 2
    add_monster(far, 5)
    assert_equal ".", @game.rows[5][far]
  end

  def test_nearby_monsters_are_drawn
    arena
    add_monster(7, 5)
    assert_equal "g", @game.rows[5][7]
  end

  # --- message log ---

  def test_log_keeps_only_the_last_four_messages
    arena(px: 1, py: 1)
    6.times { @game.move(-1, 0) }
    assert_equal 4, @game.log.size
    assert(@game.log.all?("You bump the wall."))
  end
end

class WebGameTest < Minitest::Test
  def setup
    srand(1234)
    @web = WebGame.new
  end

  def test_home_page_shows_the_map_and_status
    status, headers, body = @web.respond("GET", "/")
    assert_equal 200, status
    assert_match(/text\/html/, headers["Content-Type"])
    assert_includes body, "Depth 1"
    assert_includes body, "@"
    refute_includes body.split("<pre>", 2).last.split("</pre>").first, ">", "stairs are escaped"
  end

  # An open floor with nothing on it, player at (5, 5)
  def open_floor
    game = @web.game
    game.instance_variable_set(:@map, Array.new(Dungeon::HEIGHT) { Array.new(Dungeon::WIDTH, ".") })
    game.instance_variable_set(:@monsters, [])
    game.instance_variable_set(:@treasure, {})
    game.instance_variable_set(:@px, 5)
    game.instance_variable_set(:@py, 5)
  end

  def player = [@web.game.instance_variable_get(:@px), @web.game.instance_variable_get(:@py)]

  def test_posting_a_move_moves_and_redirects_home
    open_floor
    status, headers, = @web.respond("POST", "/move?dx=1&dy=0")
    assert_equal 303, status
    assert_equal "/", headers["Location"]
    assert_equal [6, 5], player
  end

  def test_moves_are_clamped_to_one_step
    open_floor
    @web.respond("POST", "/move?dx=9&dy=-9")
    assert_equal [6, 4], player
  end

  def test_new_game_replaces_the_dungeon
    old = @web.game
    assert_equal 303, @web.respond("POST", "/new").first
    refute_same old, @web.game
  end

  def test_unknown_paths_are_not_found
    assert_equal 404, @web.respond("GET", "/favicon.ico").first
    assert_equal 404, @web.respond("POST", "/teleport").first
  end
end
