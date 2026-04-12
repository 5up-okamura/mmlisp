; GMLisp demo skeleton 1
; Purpose: loop/marker stability + base/delta modulation

(def main-tempo 120)

(def fb-init 2)

(score :id :demo1-stage-loop
  :title "Demo 1 Stage Loop"
  :author "okamura"

  (track :main
    :loop true
    :role :bgm
    :ch [:fm1]

    (phrase :riff
      :tempo main-tempo
      :len 1/8

      (marker :intro)
      (param-set :fm-fb fb-init)

      (loop-begin :a)
      (notes :c4 :e4 :g4 _)
      (param-add :fm-fb +1)
      (note :a4)
      (rest 1/8)
      (param-add :fm-fb -1)
      (loop-end :a 4)

      (marker :turn)
      (note :f4 1/4)
      (rest 1/8)
      (jump :intro)
    )
  )
)
