# app.rb
require "scarpe"

Scarpe.app(title: "Scarpe 0.1.0 Example", width: 400, height: 300) do
  para "Hello, Scarpe!"

  @counter = 0
  @status = para "Count: #{@counter}"

  button "Click Me!" do
    @counter += 1
    @status.replace("Count: #{@counter}")
  end
end
