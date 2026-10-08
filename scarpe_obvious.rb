# Run with: scarpe scarpe_obvious.rb

require 'scarpe'

# Scarpe.app(title: "Obviously Scarpe",
#            width: 400, height: 250,
#            background: "#F0F0F0") do
#   stack do
#     title "BOOM!"
#     para "Scarpe is alive."
#     @count = para "Clicks: 0"
#     clicks = 0
#
#     button("Click Me") do
#       clicks += 1
#       @count.replace "Clicks: #{clicks}"
#     end
#   end
# end

# Add stations here; a %d in the URL gets a fresh nocache number per open
STATIONS = {
  "KSPC 88.7 Claremont" => "https://kspcradio887.radioca.st/stream128?type=http&nocache=%d",
  "WWOZ" => "https://www.wwoz.org/listen/player/",
  "KFJC" => "https://kfjc.org/player/",
  "KZSC" => "https://kzsc.org/listen/",
  "WFMU" => "https://www.wfmu.org/listen-live/",
}

# xdg-open hands each URL to the desktop default: streams to the audio player,
# player pages to the browser. It exits immediately, so there is nothing to stop.
Scarpe.app do
  @note = para "Pick a station"

  @stack = stack do
    STATIONS.each do |name, url|
      # Buttons render inline, so each gets its own stack to force one per row
      station = nil
      stack { station = button name }

      station.click {
        target = url.include?("%d") ? format(url, rand(100)) : url
        Process.detach(spawn("xdg-open", target, out: File::NULL, err: File::NULL))
        @note.replace "Opened #{name}"
      }
    end
  end
end
